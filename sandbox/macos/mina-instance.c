// mina-instance: the native helper of Mina on macOS (docs/macos.md, "Linux parity design").
//
// launchd starts each Mina job with this program: the instance job and one job for each call. macOS gives privacy
// permissions (for example ~/Documents) to the program of the job, so this program starts its child with posix_spawn
// and stays its parent. Each launchd job has its own resource coalition. A process cannot leave its coalition, so a
// coalition is the macOS replacement for the PID namespace of a Linux worker and for the systemd scope of an instance.
//
// Roles (argv[1]):
//   attach SOCKET PLIST LABEL      In the user's terminal: start the instance job, give it this terminal (fds 0-2),
//                                  pass on signals, and exit with the exit status of the instance.
//   instance SOCKET -- ARGV...     The program of the instance job: take the terminal, run ARGV (the supervisor).
//   call SOCKET TOKEN              The program of a call job: take one call from the supervisor and run it.
//   relay SOCKET                   In Pi's sandbox: send the request in $MINA_CALL to the supervisor, relay stdio, and
//                                  exit with the exit status of the call.
//   limit MEMORY_MB -- ARGV...     Inside a call's sandbox: run ARGV with a kernel memory bound (jetsam).
//   pgrp -- ARGV...                Run ARGV in a new process group of the caller's session (the supervisor runs Pi so).
//   run -- ARGV...                 The program of the host broker's jobs: run ARGV as a child, pass on stop signals.
//   fdpath FD...                   Print the path of each open file descriptor (empty for a pipe or a socket).
//   coalition PID                  Print the resource coalition ID of PID.
//   members CID...                 Print the members of these coalitions: pid ppid start_s footprint cpu_ns zombie stopped comm.
//   sweep CID...                   Stop all members of these coalitions. Exit 0 when none remain.
//   version                        Print the source hash that this binary was built from.
//
// Frames on the sockets: 1 byte type, 4 bytes big-endian length, then the payload (at most FRAME_MAX bytes).
//   H hello (call -> supervisor): "TOKEN\nCOALITION\nPID"          R request (relay -> supervisor): JSON
//   A arguments (supervisor -> call): CWD\0ARGC\0ARGV...\0ENV...\0  P pid (instance -> attach): decimal
//   I stdin data   i stdin end   K signal (decimal)               O stdout data   E stderr data
//   X exit: "CODE SIGNAL" (decimal)                               F failure before start: message (then X follows)
//   Z (instance -> attach): Pi suspended itself; the terminal's job stops
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/proc.h>
#include <sys/param.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef MINA_SOURCE_SHA
#define MINA_SOURCE_SHA "unknown"
#endif

extern char **environ;
// Private libsystem SPI (xnu libsyscall posix_spawn_private.h), the mechanism of launchd's JetsamMemoryLimit: the kernel
// kills the process when its memory footprint passes the limit. An unprivileged process can set it for a child it spawns.
extern int posix_spawnattr_setjetsam_ext(posix_spawnattr_t *attr, short flags, int priority, int memlimit_active, int memlimit_inactive);
#define POSIX_SPAWN_JETSAM_MEMLIMIT_ACTIVE_FATAL 0x04
#define POSIX_SPAWN_JETSAM_MEMLIMIT_INACTIVE_FATAL 0x08

#define FRAME_MAX (1 << 20)
// xnu bsd/sys/proc_info_private.h: PROC_PIDCOALITIONINFO; the result is uint64 coalition_id[2] (resource, jetsam) and
// three reserved uint64.
#define PROC_PIDCOALITIONINFO 20
#ifndef POSIX_SPAWN_SETSID
#define POSIX_SPAWN_SETSID 0x0400
#endif

static void die(const char *what) {
  fprintf(stderr, "mina-instance: %s: %s\n", what, strerror(errno));
  exit(125);
}

// ---------------------------------------------------------------------------- frames

// Writes everything, also to a non-blocking descriptor (it waits until the descriptor can take more).
static int write_all(int fd, const void *buf, size_t n) {
  const char *p = buf;
  while (n) {
    ssize_t w = write(fd, p, n);
    if (w < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN) { fd_set ws; FD_ZERO(&ws); FD_SET(fd, &ws); select(fd + 1, NULL, &ws, NULL, NULL); continue; }
      return -1;
    }
    p += w; n -= (size_t)w;
  }
  return 0;
}

static int read_all(int fd, void *buf, size_t n) {
  char *p = buf;
  while (n) {
    ssize_t r = read(fd, p, n);
    if (r < 0) { if (errno == EINTR) continue; return -1; }
    if (r == 0) return 0;
    p += r; n -= (size_t)r;
  }
  return 1;
}

static int send_frame(int fd, char type, const void *data, size_t n) {
  unsigned char h[5] = { (unsigned char)type, (unsigned char)(n >> 24), (unsigned char)(n >> 16), (unsigned char)(n >> 8), (unsigned char)n };
  if (write_all(fd, h, 5)) return -1;
  return n ? write_all(fd, data, n) : 0;
}

static int send_text(int fd, char type, const char *s) { return send_frame(fd, type, s, strlen(s)); }

// Reads one whole frame (blocking). Returns 1 with *data malloc'd (NUL-terminated), 0 at EOF, -1 on error.
static int recv_frame(int fd, char *type, char **data, size_t *n) {
  unsigned char h[5];
  int r = read_all(fd, h, 5);
  if (r <= 0) return r;
  size_t len = ((size_t)h[1] << 24) | ((size_t)h[2] << 16) | ((size_t)h[3] << 8) | h[4];
  if (len > FRAME_MAX) { errno = EMSGSIZE; return -1; }
  char *buf = malloc(len + 1);
  if (!buf) return -1;
  if (len && read_all(fd, buf, len) <= 0) { free(buf); return -1; }
  buf[len] = 0;
  *type = (char)h[0]; *data = buf; *n = len;
  return 1;
}

// A frame parser for a non-blocking stream: feed bytes, take complete frames.
struct parser { char *buf; size_t len, cap; };

static void parser_feed(struct parser *p, const char *data, size_t n) {
  if (p->len + n > p->cap) {
    size_t cap = p->cap ? p->cap : 65536;
    while (cap < p->len + n) cap *= 2;
    p->buf = realloc(p->buf, cap);
    if (!p->buf) die("realloc");
    p->cap = cap;
  }
  memcpy(p->buf + p->len, data, n);
  p->len += n;
}

// Returns 1 and the frame (type, a pointer into the buffer, length) when one is complete. parser_drop removes it.
static int parser_next(struct parser *p, char *type, char **data, size_t *n) {
  if (p->len < 5) return 0;
  unsigned char *h = (unsigned char *)p->buf;
  size_t len = ((size_t)h[1] << 24) | ((size_t)h[2] << 16) | ((size_t)h[3] << 8) | h[4];
  if (len > FRAME_MAX) { errno = EMSGSIZE; return -1; }
  if (p->len < 5 + len) return 0;
  *type = (char)h[0]; *data = p->buf + 5; *n = len;
  return 1;
}

static void parser_drop(struct parser *p, size_t n) {
  memmove(p->buf, p->buf + 5 + n, p->len - 5 - n);
  p->len -= 5 + n;
}

static int connect_unix(const char *path) {
  int s = socket(AF_UNIX, SOCK_STREAM, 0);
  if (s < 0) die("socket");
  struct sockaddr_un a = { .sun_family = AF_UNIX };
  if (strlen(path) >= sizeof a.sun_path) { errno = ENAMETOOLONG; die(path); }
  strcpy(a.sun_path, path);
  if (connect(s, (struct sockaddr *)&a, sizeof a)) die(path);
  int one = 1;
  setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
  return s;
}

static void nonblock(int fd) { fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK); }

// ---------------------------------------------------------------------------- coalitions

static uint64_t coalition_of(pid_t pid) {
  uint64_t info[5] = {0};
  int n = proc_pidinfo(pid, PROC_PIDCOALITIONINFO, 0, info, sizeof info);
  return n == (int)sizeof info ? info[0] : 0;
}

static pid_t *all_pids(int *count) {
  int n = proc_listallpids(NULL, 0);
  if (n < 0) n = 0;
  pid_t *p = calloc((size_t)n + 1024, sizeof(pid_t));
  if (!p) die("calloc");
  n = proc_listallpids(p, (int)(((size_t)n + 1024) * sizeof(pid_t)));
  *count = n < 0 ? 0 : n;
  return p;
}

static int in_set(uint64_t c, uint64_t *set, int n) {
  for (int i = 0; i < n; i++) if (set[i] == c) return 1;
  return 0;
}

static int is_zombie(pid_t pid) {
  struct proc_bsdshortinfo s;
  if (proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0, &s, sizeof s) != (int)sizeof s) return 1; // gone
  return s.pbsi_status == SZOMB;
}

// Stops all members of the coalitions, except this process. First SIGSTOP (a stopped process cannot fork), then SIGKILL,
// in rounds until no member remains. Returns the number of members left after `rounds` rounds (0 = all stopped).
static int sweep(uint64_t *set, int n, int rounds) {
  pid_t self = getpid();
  for (int round = 0; round < rounds; round++) {
    int count, left = 0;
    pid_t *p = all_pids(&count);
    for (int i = 0; i < count; i++) {
      if (p[i] <= 1 || p[i] == self || !in_set(coalition_of(p[i]), set, n) || is_zombie(p[i])) continue;
      p[left++] = p[i];
    }
    for (int i = 0; i < left; i++) kill(p[i], SIGSTOP);
    for (int i = 0; i < left; i++) kill(p[i], SIGKILL);
    free(p);
    if (!left) return 0;
    // Reap own children so they do not stay as zombies; the others are reaped by their parents or launchd.
    while (waitpid(-1, NULL, WNOHANG) > 0) {}
    struct timespec ts = { 0, 2 * 1000 * 1000 };
    nanosleep(&ts, NULL);
  }
  int count, left = 0;
  pid_t *p = all_pids(&count);
  for (int i = 0; i < count; i++) if (p[i] > 1 && p[i] != self && in_set(coalition_of(p[i]), set, n) && !is_zombie(p[i])) left++;
  free(p);
  return left;
}

static void sweep_self(void) {
  uint64_t own = coalition_of(getpid());
  if (own) sweep(&own, 1, 5000);
}

static int cmd_members(int argc, char **argv) {
  uint64_t set[64]; int n = 0;
  for (int i = 0; i < argc && n < 64; i++) set[n++] = strtoull(argv[i], NULL, 10);
  mach_timebase_info_data_t tb; mach_timebase_info(&tb);
  int count;
  pid_t *p = all_pids(&count);
  for (int i = 0; i < count; i++) {
    if (p[i] <= 0 || !in_set(coalition_of(p[i]), set, n)) continue;
    struct proc_bsdinfo b;
    if (proc_pidinfo(p[i], PROC_PIDTBSDINFO, 0, &b, sizeof b) != (int)sizeof b) continue;
    struct rusage_info_v2 ru;
    uint64_t footprint = 0, cpu = 0;
    if (proc_pid_rusage(p[i], RUSAGE_INFO_V2, (rusage_info_t *)&ru) == 0) {
      footprint = ru.ri_phys_footprint;
      cpu = (ru.ri_user_time + ru.ri_system_time) * tb.numer / tb.denom;
    }
    printf("%d %d %llu %llu %llu %d %d %s\n", p[i], b.pbi_ppid, (unsigned long long)b.pbi_start_tvsec, (unsigned long long)footprint,
      (unsigned long long)cpu, b.pbi_status == SZOMB, b.pbi_status == SSTOP, b.pbi_comm);
  }
  free(p);
  return 0;
}

static int cmd_sweep(int argc, char **argv) {
  uint64_t set[64]; int n = 0;
  for (int i = 0; i < argc && n < 64; i++) { uint64_t c = strtoull(argv[i], NULL, 10); if (c) set[n++] = c; }
  if (!n) return 0;
  int left = sweep(set, n, 5000);
  if (left) fprintf(stderr, "mina-instance: %d processes remain\n", left);
  return left ? 1 : 0;
}

// ---------------------------------------------------------------------------- signals through a self-pipe

static int sigpipe_w = -1;
static void on_signal(int sig) {
  int saved = errno;
  unsigned char b = (unsigned char)sig;
  if (write(sigpipe_w, &b, 1) < 0) { /* full: the signal is dropped */ }
  errno = saved;
}

static int self_pipe(const int *sigs, int n) {
  int fds[2];
  if (pipe(fds)) die("pipe");
  nonblock(fds[0]); nonblock(fds[1]);
  fcntl(fds[0], F_SETFD, FD_CLOEXEC); fcntl(fds[1], F_SETFD, FD_CLOEXEC);
  sigpipe_w = fds[1];
  for (int i = 0; i < n; i++) {
    struct sigaction sa = { .sa_handler = on_signal, .sa_flags = SA_RESTART };
    sigemptyset(&sa.sa_mask);
    sigaction(sigs[i], &sa, NULL);
  }
  return fds[0];
}

static void exit_like(int code, int sig) {
  if (sig) {
    // The status of a command that a signal ended, as a shell reports it.
    exit(128 + sig);
  }
  exit(code);
}

// ---------------------------------------------------------------------------- attach (in the user's terminal)

static int cmd_attach(const char *sock, const char *plist, const char *label) {
  int srv = socket(AF_UNIX, SOCK_STREAM, 0);
  if (srv < 0) die("socket");
  struct sockaddr_un a = { .sun_family = AF_UNIX };
  if (strlen(sock) >= sizeof a.sun_path) { errno = ENAMETOOLONG; die(sock); }
  strcpy(a.sun_path, sock);
  unlink(sock);
  if (bind(srv, (struct sockaddr *)&a, sizeof a)) die(sock);
  chmod(sock, 0600);
  if (listen(srv, 1)) die("listen");
  fcntl(srv, F_SETFD, FD_CLOEXEC);

  char domain[64];
  snprintf(domain, sizeof domain, "gui/%d", getuid());
  char *largv[] = { "/bin/launchctl", "bootstrap", domain, (char *)plist, NULL };
  pid_t lp; int st;
  if (posix_spawn(&lp, largv[0], NULL, NULL, largv, environ)) die("launchctl");
  while (waitpid(lp, &st, 0) < 0 && errno == EINTR) {}
  if (!WIFEXITED(st) || WEXITSTATUS(st)) { fprintf(stderr, "mina-instance: launchctl bootstrap %s failed (%s)\n", label, plist); return 125; }

  struct timeval tv = { 30, 0 };
  setsockopt(srv, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  int c;
  while ((c = accept(srv, NULL, NULL)) < 0 && errno == EINTR) {}
  if (c < 0) { fprintf(stderr, "mina-instance: the instance job %s did not connect: %s\n", label, strerror(errno)); return 125; }
  close(srv); unlink(sock);
  uid_t euid; gid_t egid;
  if (getpeereid(c, &euid, &egid) || euid != getuid()) { fprintf(stderr, "mina-instance: refused a connection from another user\n"); return 125; }
  int one = 1;
  setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);

  // The terminal (or the pipes) of this process, for the instance.
  int fds[3] = { 0, 1, 2 };
  char byte = 'T';
  struct iovec io = { &byte, 1 };
  char cbuf[CMSG_SPACE(sizeof fds)];
  memset(cbuf, 0, sizeof cbuf);
  struct msghdr m = { .msg_iov = &io, .msg_iovlen = 1, .msg_control = cbuf, .msg_controllen = sizeof cbuf };
  struct cmsghdr *cm = CMSG_FIRSTHDR(&m);
  cm->cmsg_level = SOL_SOCKET; cm->cmsg_type = SCM_RIGHTS; cm->cmsg_len = CMSG_LEN(sizeof fds);
  memcpy(CMSG_DATA(cm), fds, sizeof fds);
  if (sendmsg(c, &m, 0) < 0) die("sendmsg");

  // The process group of the terminal gets Ctrl+C, Ctrl+\, Ctrl+Z and window size changes; the instance is not in it.
  int sigs[] = { SIGWINCH, SIGHUP, SIGTERM, SIGINT, SIGQUIT, SIGCONT, SIGTSTP };
  int sp = self_pipe(sigs, 7);
  signal(SIGPIPE, SIG_IGN);
  int kq = kqueue();
  struct kevent ev[2];
  EV_SET(&ev[0], c, EVFILT_READ, EV_ADD, 0, 0, NULL);
  EV_SET(&ev[1], sp, EVFILT_READ, EV_ADD, 0, 0, NULL);
  kevent(kq, ev, 2, NULL, 0, NULL);
  struct parser p = {0};
  for (;;) {
    struct kevent got[2];
    int n = kevent(kq, NULL, 0, got, 2, NULL);
    if (n < 0) { if (errno == EINTR) continue; die("kevent"); }
    for (int i = 0; i < n; i++) {
      if ((int)got[i].ident == sp) {
        unsigned char s[64];
        ssize_t r = read(sp, s, sizeof s);
        for (ssize_t j = 0; j < r; j++) {
          char num[16]; snprintf(num, sizeof num, "%d", s[j]); send_text(c, 'K', num);
          if (s[j] == SIGTSTP) {
            // Ctrl+Z (or the instance's own suspend, below): Pi stops; then this process stops too, as one job of the
            // shell. `fg` continues it with SIGCONT, which goes on to Pi.
            struct sigaction dfl = { .sa_handler = SIG_DFL }, own = { .sa_handler = on_signal, .sa_flags = SA_RESTART };
            sigemptyset(&dfl.sa_mask); sigemptyset(&own.sa_mask);
            sigaction(SIGTSTP, &dfl, NULL);
            kill(getpid(), SIGTSTP);
            sigaction(SIGTSTP, &own, NULL);
          }
        }
      } else {
        char buf[65536];
        ssize_t r = read(c, buf, sizeof buf);
        if (r <= 0) { fprintf(stderr, "mina: the instance ended without an exit status\n"); return 1; }
        parser_feed(&p, buf, (size_t)r);
        char t, *d; size_t len;
        while (parser_next(&p, &t, &d, &len) == 1) {
          if (t == 'X') { int code = 0, sig = 0; d[len < 63 ? len : 63] = 0; sscanf(d, "%d %d", &code, &sig); exit_like(code, sig); }
          // Pi suspended itself (Ctrl+Z in the TUI): stop the terminal's job, the launcher and this process.
          if (t == 'Z') kill(0, SIGTSTP);
          parser_drop(&p, len);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------- instance (program of the instance job)

static int cmd_instance(const char *sock, char **argv) {
  int c = connect_unix(sock);
  char byte;
  int fds[3];
  struct iovec io = { &byte, 1 };
  char cbuf[CMSG_SPACE(sizeof fds)];
  struct msghdr m = { .msg_iov = &io, .msg_iovlen = 1, .msg_control = cbuf, .msg_controllen = sizeof cbuf };
  if (recvmsg(c, &m, 0) <= 0) die("recvmsg");
  struct cmsghdr *cm = CMSG_FIRSTHDR(&m);
  if (!cm || cm->cmsg_type != SCM_RIGHTS || cm->cmsg_len != CMSG_LEN(sizeof fds)) { fprintf(stderr, "mina-instance: no terminal\n"); return 125; }
  memcpy(fds, CMSG_DATA(cm), sizeof fds);
  for (int i = 0; i < 3; i++) { dup2(fds[i], i); if (fds[i] > 2) close(fds[i]); }
  fcntl(c, F_SETFD, FD_CLOEXEC);

  pid_t child;
  if (posix_spawn(&child, argv[0], NULL, NULL, argv, environ)) {
    char msg[512]; snprintf(msg, sizeof msg, "mina-instance: cannot start %s: %s\n", argv[0], strerror(errno));
    write_all(2, msg, strlen(msg));
    send_text(c, 'X', "125 0");
    return 125;
  }
  char num[32]; snprintf(num, sizeof num, "%d", child);
  send_text(c, 'P', num);

  int kq = kqueue();
  struct kevent ev[3];
  // launchctl bootout sends SIGTERM to the program of the job: stop every process of the instance first. SIGUSR1 from
  // the supervisor: Pi has suspended itself, so the terminal's job stops too.
  signal(SIGTERM, SIG_IGN);
  signal(SIGUSR1, SIG_IGN);
  struct kevent ev4[4];
  EV_SET(&ev4[0], c, EVFILT_READ, EV_ADD, 0, 0, NULL);
  EV_SET(&ev4[1], child, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, NULL);
  EV_SET(&ev4[2], SIGTERM, EVFILT_SIGNAL, EV_ADD, 0, 0, NULL);
  EV_SET(&ev4[3], SIGUSR1, EVFILT_SIGNAL, EV_ADD, 0, 0, NULL);
  kevent(kq, ev4, 4, NULL, 0, NULL);
  (void)ev;
  signal(SIGPIPE, SIG_IGN);
  struct parser p = {0};
  for (;;) {
    struct kevent got[4];
    int n = kevent(kq, NULL, 0, got, 4, NULL);
    if (n < 0) { if (errno == EINTR) continue; die("kevent"); }
    for (int i = 0; i < n; i++) {
      if (got[i].filter == EVFILT_SIGNAL && got[i].ident == SIGUSR1) { send_text(c, 'Z', ""); continue; }
      if (got[i].filter == EVFILT_SIGNAL) { sweep_self(); return 1; }
      if (got[i].filter == EVFILT_PROC) {
        int st = 0;
        while (waitpid(child, &st, 0) < 0 && errno == EINTR) {}
        // Pi has exited: no process of the instance outlives it (the systemd scope on Linux is stopped the same way).
        sweep_self();
        char x[32]; snprintf(x, sizeof x, "%d %d", WIFEXITED(st) ? WEXITSTATUS(st) : 0, WIFSIGNALED(st) ? WTERMSIG(st) : 0);
        send_text(c, 'X', x);
        return 0;
      }
      char buf[4096];
      ssize_t r = read(c, buf, sizeof buf);
      if (r <= 0) {
        // The launcher has gone (a closed terminal, kill -9): stop the whole instance, as --die-with-parent does on Linux.
        sweep_self();
        return 1;
      }
      parser_feed(&p, buf, (size_t)r);
      char t, *d; size_t len;
      while (parser_next(&p, &t, &d, &len) == 1) {
        if (t == 'K') { char s[16] = {0}; memcpy(s, d, len < 15 ? len : 15); int sig = atoi(s); if (sig > 0 && sig < NSIG) kill(child, sig); }
        parser_drop(&p, len);
      }
    }
  }
}

// ---------------------------------------------------------------------------- call (program of a call job)

struct out { int fd; char type; int open; };

static int cmd_call(const char *sock, const char *token) {
  signal(SIGPIPE, SIG_IGN);
  int c = connect_unix(sock);
  fcntl(c, F_SETFD, FD_CLOEXEC);
  char hello[256];
  snprintf(hello, sizeof hello, "%s\n%llu\n%d", token, (unsigned long long)coalition_of(getpid()), getpid());
  if (send_text(c, 'H', hello)) return 125;

  // Wait for the call. A spare job waits here until the supervisor needs it, or until the supervisor exits.
  char t, *args; size_t n;
  int r = recv_frame(c, &t, &args, &n);
  if (r <= 0 || t != 'A') { sweep_self(); return r == 0 ? 0 : 125; }
  // From now on, launchctl bootout (SIGTERM to the program of the job) first stops every process of the call.
  signal(SIGTERM, SIG_IGN);
  // CWD\0ARGC\0ARGV...\0ENV...\0
  char *list[8192]; int count = 0;
  for (size_t i = 0; i < n && count < 8191; ) { list[count++] = args + i; i += strlen(args + i) + 1; }
  if (count < 3) { send_text(c, 'F', "mina-instance: malformed call\n"); send_text(c, 'X', "125 0"); return 125; }
  const char *cwd = list[0];
  int argc = atoi(list[1]);
  if (argc < 1 || 2 + argc > count) { send_text(c, 'F', "mina-instance: malformed call\n"); send_text(c, 'X', "125 0"); return 125; }
  char **cargv = calloc((size_t)argc + 1, sizeof(char *));
  for (int i = 0; i < argc; i++) cargv[i] = list[2 + i];
  int envc = count - 2 - argc;
  char **cenv = calloc((size_t)envc + 1, sizeof(char *));
  for (int i = 0; i < envc; i++) cenv[i] = list[2 + argc + i];

  int in[2], o[2], e[2];
  if (pipe(in) || pipe(o) || pipe(e)) die("pipe");
  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  posix_spawn_file_actions_adddup2(&fa, in[0], 0);
  posix_spawn_file_actions_adddup2(&fa, o[1], 1);
  posix_spawn_file_actions_adddup2(&fa, e[1], 2);
  posix_spawn_file_actions_addchdir(&fa, cwd);
  posix_spawnattr_t at;
  posix_spawnattr_init(&at);
  // A new session, as bwrap --new-session: no controlling terminal, its own process group. CLOEXEC_DEFAULT: the child
  // gets only fds 0-2, never the socket to the supervisor.
  posix_spawnattr_setflags(&at, POSIX_SPAWN_SETSID | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_CLOEXEC_DEFAULT);
  sigset_t all, none; sigfillset(&all); sigemptyset(&none);
  posix_spawnattr_setsigdefault(&at, &all);
  posix_spawnattr_setsigmask(&at, &none);
  pid_t child;
  int err = posix_spawn(&child, cargv[0], &fa, &at, cargv, cenv);
  close(in[0]); close(o[1]); close(e[1]);
  if (err) {
    char msg[512]; snprintf(msg, sizeof msg, "mina-instance: cannot start %s: %s\n", cargv[0], strerror(err));
    send_text(c, 'F', msg); send_text(c, 'X', "126 0");
    return 126;
  }
  nonblock(in[1]); nonblock(o[0]); nonblock(e[0]); nonblock(c);

  struct out outs[2] = { { o[0], 'O', 1 }, { e[0], 'E', 1 } };
  int kq = kqueue();
  struct kevent ev[5];
  EV_SET(&ev[0], c, EVFILT_READ, EV_ADD, 0, 0, NULL);
  EV_SET(&ev[1], o[0], EVFILT_READ, EV_ADD, 0, 0, NULL);
  EV_SET(&ev[2], e[0], EVFILT_READ, EV_ADD, 0, 0, NULL);
  EV_SET(&ev[3], child, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, NULL);
  EV_SET(&ev[4], SIGTERM, EVFILT_SIGNAL, EV_ADD, 0, 0, NULL);
  kevent(kq, ev, 5, NULL, 0, NULL);
  struct parser p = {0};
  char *pending = NULL; size_t pend_len = 0, pend_off = 0; int stdin_open = 1, stdin_eof = 0;
  int exited = 0, status = 0;
  char buf[65536];
  for (;;) {
    struct kevent got[5];
    int k = kevent(kq, NULL, 0, got, 5, NULL);
    if (k < 0) { if (errno == EINTR) continue; die("kevent"); }
    for (int i = 0; i < k; i++) {
      if (got[i].filter == EVFILT_SIGNAL) { sweep_self(); return 1; }
      if (got[i].filter == EVFILT_PROC) {
        while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
        exited = 1;
      } else if (got[i].filter == EVFILT_WRITE && (int)got[i].ident == in[1]) {
        // continue below
      } else if ((int)got[i].ident == c) {
        ssize_t r = read(c, buf, sizeof buf);
        if (r == 0 || (r < 0 && errno != EAGAIN && errno != EINTR)) {
          // The client has gone (a timeout, an abort, a killed relay): stop the call, as a dead bwrap stops its namespace.
          sweep_self();
          return 1;
        }
        if (r > 0) parser_feed(&p, buf, (size_t)r);
        char ft, *d; size_t len;
        while (parser_next(&p, &ft, &d, &len) == 1) {
          if (ft == 'I' && stdin_open) {
            // Drop the part already written, then grow: never read past the old end.
            if (pend_off) { memmove(pending, pending + pend_off, pend_len - pend_off); pend_len -= pend_off; pend_off = 0; }
            char *grown = realloc(pending, pend_len + len);
            if (!grown) die("realloc");
            pending = grown;
            memcpy(pending + pend_len, d, len); pend_len += len;
          } else if (ft == 'i') stdin_eof = 1;
          else if (ft == 'K') { char s[16] = {0}; memcpy(s, d, len < 15 ? len : 15); int sig = atoi(s); if (sig > 0 && sig < NSIG) kill(child, sig); }
          parser_drop(&p, len);
        }
      } else {
        for (int j = 0; j < 2; j++) {
          if ((int)got[i].ident != outs[j].fd || !outs[j].open) continue;
          ssize_t r = read(outs[j].fd, buf, sizeof buf);
          if (r > 0) { if (send_frame(c, outs[j].type, buf, (size_t)r)) { sweep_self(); return 1; } }
          else if (r == 0 || (errno != EAGAIN && errno != EINTR)) { outs[j].open = 0; close(outs[j].fd); }
        }
      }
    }
    // Feed stdin without blocking; a command that does not read its input must not stop the relay.
    if (stdin_open && pend_len > pend_off) {
      ssize_t w = write(in[1], pending + pend_off, pend_len - pend_off);
      if (w > 0) pend_off += (size_t)w;
      else if (w < 0 && errno == EPIPE) stdin_open = 0;
      if (pend_len > pend_off) { struct kevent we; EV_SET(&we, in[1], EVFILT_WRITE, EV_ADD | EV_ONESHOT, 0, 0, NULL); kevent(kq, &we, 1, NULL, 0, NULL); }
    }
    if (stdin_open && stdin_eof && pend_len == pend_off) { close(in[1]); stdin_open = 0; }
    if (exited) {
      // The main process has exited. As at the end of a Linux PID namespace, every other process of the call stops now.
      sweep_self();
      if (stdin_open) { close(in[1]); stdin_open = 0; }
      // All writers are gone: read what is left in the pipes, then report.
      for (int j = 0; j < 2; j++) {
        if (!outs[j].open) continue;
        fcntl(outs[j].fd, F_SETFL, fcntl(outs[j].fd, F_GETFL) & ~O_NONBLOCK);
        ssize_t r;
        while ((r = read(outs[j].fd, buf, sizeof buf)) > 0) send_frame(c, outs[j].type, buf, (size_t)r);
        close(outs[j].fd); outs[j].open = 0;
      }
      char x[32];
      snprintf(x, sizeof x, "%d %d", WIFEXITED(status) ? WEXITSTATUS(status) : 0, WIFSIGNALED(status) ? WTERMSIG(status) : 0);
      send_text(c, 'X', x);
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------- limit (inside a call's sandbox)

// Runs ARGV with a kernel memory bound: a jetsam limit, set at spawn because an exec resets it. On Linux RLIMIT_AS bounds
// the PDF converter; macOS does not lower RLIMIT_AS. The child inherits the sandbox of this process.
static int cmd_limit(int mb, char **argv) {
  if (mb <= 0) { fprintf(stderr, "mina-instance limit: the bound must be positive\n"); return 126; }
  posix_spawnattr_t at;
  posix_spawnattr_init(&at);
  if (posix_spawnattr_setjetsam_ext(&at, POSIX_SPAWN_JETSAM_MEMLIMIT_ACTIVE_FATAL | POSIX_SPAWN_JETSAM_MEMLIMIT_INACTIVE_FATAL, -1, mb, mb)) {
    fprintf(stderr, "mina-instance limit: cannot set the memory bound\n");   // fail closed: never run without it
    return 126;
  }
  pid_t child;
  int err = posix_spawn(&child, argv[0], NULL, &at, argv, environ);
  if (err) { fprintf(stderr, "mina-instance limit: cannot start %s: %s\n", argv[0], strerror(err)); return err == ENOENT ? 127 : 126; }
  int st;
  while (waitpid(child, &st, 0) < 0 && errno == EINTR) {}
  if (WIFSIGNALED(st)) { signal(WTERMSIG(st), SIG_DFL); kill(getpid(), WTERMSIG(st)); }
  return WIFEXITED(st) ? WEXITSTATUS(st) : 1;
}

// ---------------------------------------------------------------------------- run (program of other Mina jobs)

// The program of a launchd job of Mina's host broker (the broker itself and each workload): run ARGV as a child and stay
// its parent, so that macOS gives privacy permissions to mina-instance, as for an instance. Signals that stop a job
// (SIGTERM from launchctl bootout, SIGINT, SIGHUP) go to the child; the exit status is the child's.
static pid_t run_child = 0;
static void run_forward(int sig) { if (run_child > 0) kill(run_child, sig); }

static int cmd_run(char **argv) {
  struct sigaction sa = { .sa_handler = run_forward, .sa_flags = SA_RESTART };
  sigemptyset(&sa.sa_mask);
  int err = posix_spawn(&run_child, argv[0], NULL, NULL, argv, environ);
  if (err) { fprintf(stderr, "mina-instance run: cannot start %s: %s\n", argv[0], strerror(err)); return err == ENOENT ? 127 : 126; }
  sigaction(SIGTERM, &sa, NULL); sigaction(SIGINT, &sa, NULL); sigaction(SIGHUP, &sa, NULL);
  int st;
  while (waitpid(run_child, &st, 0) < 0 && errno == EINTR) {}
  if (WIFSIGNALED(st)) { signal(WTERMSIG(st), SIG_DFL); kill(getpid(), WTERMSIG(st)); }
  return WIFEXITED(st) ? WEXITSTATUS(st) : 1;
}

// ---------------------------------------------------------------------------- relay (in Pi's sandbox)

static int cmd_relay(const char *sock) {
  const char *req = getenv("MINA_CALL");
  if (!req) { fprintf(stderr, "mina-instance relay: MINA_CALL is not set\n"); return 125; }
  signal(SIGPIPE, SIG_IGN);
  int c = connect_unix(sock);
  if (send_text(c, 'R', req)) die("send");
  nonblock(c); nonblock(0);
  int kq = kqueue();
  struct kevent ev[2];
  EV_SET(&ev[0], c, EVFILT_READ, EV_ADD, 0, 0, NULL);
  EV_SET(&ev[1], 0, EVFILT_READ, EV_ADD, 0, 0, NULL);
  kevent(kq, ev, 2, NULL, 0, NULL);
  struct parser p = {0};
  int stdin_open = 1;
  char buf[65536];
  for (;;) {
    struct kevent got[2];
    int n = kevent(kq, NULL, 0, got, 2, NULL);
    if (n < 0) { if (errno == EINTR) continue; die("kevent"); }
    for (int i = 0; i < n; i++) {
      if ((int)got[i].ident == 0 && stdin_open) {
        ssize_t r = read(0, buf, sizeof buf);
        if (r > 0) {
          // The socket is non-blocking for reads only in effect: a full socket buffer waits here.
          fcntl(c, F_SETFL, fcntl(c, F_GETFL) & ~O_NONBLOCK);
          send_frame(c, 'I', buf, (size_t)r);
          fcntl(c, F_SETFL, fcntl(c, F_GETFL) | O_NONBLOCK);
        } else if (r == 0 || (errno != EAGAIN && errno != EINTR)) {
          fcntl(c, F_SETFL, fcntl(c, F_GETFL) & ~O_NONBLOCK);
          send_frame(c, 'i', NULL, 0);
          fcntl(c, F_SETFL, fcntl(c, F_GETFL) | O_NONBLOCK);
          stdin_open = 0;
          struct kevent del; EV_SET(&del, 0, EVFILT_READ, EV_DELETE, 0, 0, NULL); kevent(kq, &del, 1, NULL, 0, NULL);
        }
      } else if ((int)got[i].ident == c) {
        ssize_t r = read(c, buf, sizeof buf);
        if (r == 0) { fprintf(stderr, "mina: the sandbox supervisor ended the call without an exit status\n"); return 125; }
        if (r < 0) { if (errno == EAGAIN || errno == EINTR) continue; return 125; }
        parser_feed(&p, buf, (size_t)r);
        char t, *d; size_t len;
        while (parser_next(&p, &t, &d, &len) == 1) {
          if (t == 'O') write_all(1, d, len);
          else if (t == 'E' || t == 'F') write_all(2, d, len);
          else if (t == 'X') { int code = 0, sig = 0; char s[64] = {0}; memcpy(s, d, len < 63 ? len : 63); sscanf(s, "%d %d", &code, &sig); exit_like(code, sig); }
          parser_drop(&p, len);
        }
      }
    }
  }
}

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: mina-instance attach|instance|call|relay|coalition|members|sweep|version ...\n"); return 2; }
  const char *role = argv[1];
  if (!strcmp(role, "version")) { printf("%s\n", MINA_SOURCE_SHA); return 0; }
  // The instance and call roles stop every other process of their own coalition. Outside a launchd job that would be the
  // coalition of the terminal application, so these roles run only as the program of a launchd job (parent: launchd).
  if ((!strcmp(role, "instance") || !strcmp(role, "call")) && getppid() != 1) {
    fprintf(stderr, "mina-instance: the %s role runs only as the program of a launchd job\n", role);
    return 2;
  }
  if (!strcmp(role, "attach") && argc == 5) return cmd_attach(argv[2], argv[3], argv[4]);
  if (!strcmp(role, "instance") && argc > 4 && !strcmp(argv[3], "--")) return cmd_instance(argv[2], argv + 4);
  if (!strcmp(role, "call") && argc == 4) return cmd_call(argv[2], argv[3]);
  if (!strcmp(role, "relay") && argc == 3) return cmd_relay(argv[2]);
  if (!strcmp(role, "limit") && argc > 4 && !strcmp(argv[3], "--")) return cmd_limit(atoi(argv[2]), argv + 4);
  if (!strcmp(role, "run") && argc > 3 && !strcmp(argv[2], "--")) return cmd_run(argv + 3);
  if (!strcmp(role, "fdpath")) {
    // The path of each open file descriptor (fcntl F_GETPATH), one per line; an empty line for a pipe or socket.
    for (int i = 2; i < argc; i++) {
      char path[MAXPATHLEN] = "";
      struct stat st;
      int fd = atoi(argv[i]);
      if (fstat(fd, &st) == 0 && (S_ISREG(st.st_mode) || S_ISCHR(st.st_mode) || S_ISDIR(st.st_mode)) && fcntl(fd, F_GETPATH, path) == 0) printf("%s\n", path);
      else printf("\n");
    }
    return 0;
  }
  if (!strcmp(role, "pgrp") && argc > 3 && !strcmp(argv[2], "--")) {
    // A process group of its own in the caller's session (not a new session: the kernel discards stop signals to an
    // orphaned group, and Pi's Ctrl+Z must stop it, as in a terminal's job).
    if (setpgid(0, 0)) die("setpgid");
    execv(argv[3], argv + 3);
    die(argv[3]);
  }
  if (!strcmp(role, "coalition") && argc == 3) { printf("%llu\n", (unsigned long long)coalition_of(atoi(argv[2]))); return 0; }
  if (!strcmp(role, "members")) return cmd_members(argc - 2, argv + 2);
  if (!strcmp(role, "sweep")) return cmd_sweep(argc - 2, argv + 2);
  fprintf(stderr, "mina-instance: unknown role or arguments: %s\n", role);
  return 2;
}
