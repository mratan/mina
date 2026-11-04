// ps, pgrep and pkill for a macOS worker (docs/macos.md). Run as `ps`, `pgrep` or `pkill` (symlinks in build/macos/bin,
// first in the worker's PATH).
//
// On Linux, these tools in a worker see the processes of the worker's own PID namespace. On macOS, /bin/ps and
// /usr/bin/top are setuid or entitled and cannot run in a Seatbelt sandbox, and pgrep and pkill need the sysmond service,
// which the worker profile denies. These replacements list the processes that the worker can see: the processes of its
// own sandbox (the profile allows process information only for them), which is the macOS form of the namespace view.
// They support the common forms: ps [aux | -ef | -e | -A | -p PIDS | -o FIELDS | -ww], and pgrep/pkill
// [-f -l -a -x -i -v -n -o -c -P PPIDS -u USERS -d DELIM] PATTERN, pkill [-SIGNAL | -s SIGNAL].
#include <ctype.h>
#include <errno.h>
#include <libproc.h>
#include <pwd.h>
#include <regex.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#include <time.h>
#include <unistd.h>
#include <mach/mach_time.h>

struct proc {
  pid_t pid, ppid, pgid;
  uid_t uid;
  int status;
  char comm[MAXCOMLEN + 1];
  char args[4096];
  uint64_t start_s, cpu_ns, rss, vsz;
  int running;                                                            // threads running now (-1: unknown)
  dev_t tdev;
};

static void read_args(pid_t pid, char *out, size_t cap, const char *fallback) {
  int mib[3] = { CTL_KERN, KERN_PROCARGS2, pid };
  static char buf[262144];
  size_t len = sizeof buf;
  out[0] = 0;
  if (sysctl(mib, 3, buf, &len, NULL, 0) == 0 && len > sizeof(int)) {
    int argc; memcpy(&argc, buf, sizeof argc);
    char *p = buf + sizeof(int), *end = buf + len;
    p += strnlen(p, (size_t)(end - p));                                  // the executable path
    while (p < end && !*p) p++;
    size_t at = 0;
    for (int i = 0; i < argc && p < end; i++) {
      size_t n = strnlen(p, (size_t)(end - p));
      if (at && at + 1 < cap) out[at++] = ' ';
      for (size_t k = 0; k < n && at + 1 < cap; k++) out[at++] = p[k];
      p += n + 1;
    }
    out[at] = 0;
  }
  if (!out[0]) snprintf(out, cap, "%s", fallback);
}

// The processes this sandbox can see (process information of others is denied).
static struct proc *visible(int *count) {
  int n = proc_listallpids(NULL, 0);
  pid_t *pids = calloc((size_t)(n > 0 ? n : 0) + 256, sizeof(pid_t));
  n = proc_listallpids(pids, (int)(((size_t)(n > 0 ? n : 0) + 256) * sizeof(pid_t)));
  struct proc *out = calloc((size_t)(n > 0 ? n : 1), sizeof(struct proc));
  mach_timebase_info_data_t tb; mach_timebase_info(&tb);
  int k = 0;
  for (int i = 0; i < n; i++) {
    struct proc_bsdinfo b;
    if (pids[i] <= 0 || proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &b, sizeof b) != (int)sizeof b) continue;
    struct proc *p = &out[k++];
    p->pid = pids[i]; p->ppid = (pid_t)b.pbi_ppid; p->pgid = (pid_t)b.pbi_pgid; p->uid = b.pbi_uid; p->status = (int)b.pbi_status;
    p->start_s = b.pbi_start_tvsec; p->tdev = (dev_t)b.e_tdev;
    snprintf(p->comm, sizeof p->comm, "%s", b.pbi_comm);
    struct proc_taskinfo t;
    p->running = -1;
    if (proc_pidinfo(pids[i], PROC_PIDTASKINFO, 0, &t, sizeof t) == (int)sizeof t) {
      p->running = t.pti_numrunning;
      p->cpu_ns = (t.pti_total_user + t.pti_total_system) * tb.numer / tb.denom;
      p->rss = t.pti_resident_size; p->vsz = t.pti_virtual_size;
    }
    read_args(p->pid, p->args, sizeof p->args, p->comm);
  }
  free(pids);
  *count = k;
  return out;
}

static const char *user_of(uid_t uid) {
  static char num[16];
  struct passwd *pw = getpwuid(uid);
  if (pw) return pw->pw_name;
  snprintf(num, sizeof num, "%u", uid);
  return num;
}

// As BSD ps: a runnable process with no thread on a CPU is sleeping.
static char state_of(int status, int running) {
  switch (status) { case SIDL: return 'I'; case SRUN: return running == 0 ? 'S' : 'R'; case SSLEEP: return 'S'; case SSTOP: return 'T'; case SZOMB: return 'Z'; default: return '?'; }
}

static void tty_of(dev_t d, char *out, size_t cap) {
  if (d == (dev_t)-1 || d == 0) { snprintf(out, cap, "??"); return; }
  const char *name = devname(d, S_IFCHR);
  snprintf(out, cap, "%s", name ? (strncmp(name, "tty", 3) ? name : name + 3) : "??");
}

static void cputime(uint64_t ns, char *out, size_t cap) {
  uint64_t cs = ns / 10000000ULL;
  snprintf(out, cap, "%llu:%02llu.%02llu", (unsigned long long)(cs / 6000), (unsigned long long)(cs / 100 % 60), (unsigned long long)(cs % 100));
}

// ---------------------------------------------------------------------------- ps

static uint64_t memsize(void) { uint64_t m = 0; size_t l = sizeof m; sysctlbyname("hw.memsize", &m, &l, NULL, 0); return m ? m : 1; }

static void field(const struct proc *p, const char *f, int header, int last, int wide) {
  char buf[64];
  time_t now = time(NULL);
  if (!strcmp(f, "pid")) { if (header) printf("%5s", "PID"); else printf("%5d", p->pid); }
  else if (!strcmp(f, "ppid")) { if (header) printf("%5s", "PPID"); else printf("%5d", p->ppid); }
  else if (!strcmp(f, "pgid")) { if (header) printf("%5s", "PGID"); else printf("%5d", p->pgid); }
  else if (!strcmp(f, "uid")) { if (header) printf("%5s", "UID"); else printf("%5u", p->uid); }
  else if (!strcmp(f, "user")) { if (header) printf("%-10s", "USER"); else printf("%-10s", user_of(p->uid)); }
  else if (!strcmp(f, "stat") || !strcmp(f, "state")) { if (header) printf("%-4s", "STAT"); else printf("%c%-3s", state_of(p->status, p->running), p->pid == p->pgid ? "s" : ""); }
  else if (!strcmp(f, "tty") || !strcmp(f, "tt")) { if (header) printf("%-5s", "TTY"); else { tty_of(p->tdev, buf, sizeof buf); printf("%-5s", buf); } }
  else if (!strcmp(f, "time") || !strcmp(f, "cputime")) { if (header) printf("%10s", "TIME"); else { cputime(p->cpu_ns, buf, sizeof buf); printf("%10s", buf); } }
  else if (!strcmp(f, "etime")) {
    if (header) printf("%11s", "ELAPSED");
    else { long s = (long)(now - (time_t)p->start_s); printf("%5ld:%02ld:%02ld", s / 3600, s / 60 % 60, s % 60); }
  } else if (!strcmp(f, "start") || !strcmp(f, "stime") || !strcmp(f, "started")) {
    if (header) printf("%-8s", "STARTED");
    else { time_t t = (time_t)p->start_s; struct tm tm; localtime_r(&t, &tm); strftime(buf, sizeof buf, "%H:%M:%S", &tm); printf("%-8s", buf); }
  } else if (!strcmp(f, "lstart")) {
    if (header) printf("%-24s", "STARTED");
    else { time_t t = (time_t)p->start_s; char *s = ctime(&t); s[strlen(s) - 1] = 0; printf("%-24s", s); }
  } else if (!strcmp(f, "rss")) { if (header) printf("%8s", "RSS"); else printf("%8llu", (unsigned long long)(p->rss / 1024)); }
  else if (!strcmp(f, "vsz")) { if (header) printf("%10s", "VSZ"); else printf("%10llu", (unsigned long long)(p->vsz / 1024)); }
  else if (!strcmp(f, "%mem") || !strcmp(f, "pmem")) { if (header) printf("%5s", "%MEM"); else printf("%5.1f", 100.0 * (double)p->rss / (double)memsize()); }
  else if (!strcmp(f, "%cpu") || !strcmp(f, "pcpu")) {
    if (header) printf("%5s", "%CPU");
    else { double el = (double)(now - (time_t)p->start_s); printf("%5.1f", el > 0 ? 100.0 * (double)p->cpu_ns / 1e9 / el : 0.0); }
  } else if (!strcmp(f, "comm") || !strcmp(f, "ucomm") || !strcmp(f, "ucmd")) { if (header) printf("%s", "COMM"); else printf("%s", p->comm); }
  else if (!strcmp(f, "command") || !strcmp(f, "args") || !strcmp(f, "cmd")) {
    if (header) printf("%s", !strcmp(f, "args") ? "ARGS" : "COMMAND");
    else if (wide || !last) printf("%s", p->args);
    else printf("%.200s", p->args);
  } else { if (header) printf("%s", f); else printf("-"); }
}

static int cmd_ps(int argc, char **argv) {
  const char *def[] = { "pid", "tty", "time", "command", NULL };
  const char *aux[] = { "user", "pid", "%cpu", "%mem", "vsz", "rss", "tt", "stat", "started", "time", "command", NULL };
  const char *ef[] = { "uid", "pid", "ppid", "%cpu", "stime", "tty", "time", "command", NULL };
  const char *fields[64]; int nf = 0, wide = 0, noheader = 0;
  pid_t only[256]; int nonly = 0;
  const char **layout = def;
  for (int i = 1; i < argc; i++) {
    const char *a = argv[i];
    if (!strcmp(a, "--no-headers") || !strcmp(a, "--no-heading")) { noheader = 1; continue; }
    if (!strcmp(a, "-o") || !strcmp(a, "-O") || !strncmp(a, "-o", 2) || !strncmp(a, "--format", 8) || !strcmp(a, "o")) {
      const char *spec = (!strcmp(a, "-o") || !strcmp(a, "-O") || !strcmp(a, "o") || !strcmp(a, "--format")) ? (i + 1 < argc ? argv[++i] : "") : (a[1] == 'o' ? a + 2 : strchr(a, '=') ? strchr(a, '=') + 1 : "");
      char *copy = strdup(spec), *save = NULL;
      for (char *t = strtok_r(copy, ", ", &save); t && nf < 63; t = strtok_r(NULL, ", ", &save)) {
        char *eq = strchr(t, '='); if (eq) *eq = 0;                       // a custom header name is not shown
        fields[nf++] = t;
      }
      continue;
    }
    if (!strcmp(a, "-p") || !strncmp(a, "-p", 2) || !strcmp(a, "p") || !strcmp(a, "--pid")) {
      const char *list = (!strcmp(a, "-p") || !strcmp(a, "p") || !strcmp(a, "--pid")) ? (i + 1 < argc ? argv[++i] : "") : a + 2;
      char *copy = strdup(list), *save = NULL;
      for (char *t = strtok_r(copy, ", ", &save); t && nonly < 256; t = strtok_r(NULL, ", ", &save)) only[nonly++] = atoi(t);
      continue;
    }
    if (!strcmp(a, "-u") || !strcmp(a, "-U") || !strcmp(a, "-t") || !strcmp(a, "-g") || !strcmp(a, "-G")) { i++; continue; }
    const char *flags = a[0] == '-' ? a + 1 : a;
    int bsd = a[0] != '-';
    for (const char *c = flags; *c; c++) {
      if (*c == 'w') wide = 1;
      else if (*c == 'f' && !bsd) layout = ef;
      else if (*c == 'u' && bsd) layout = aux;
      else if (*c == 'l' && !bsd) layout = ef;
    }
  }
  if (nf) { fields[nf] = NULL; layout = fields; }
  int n; struct proc *ps = visible(&n);
  int count = 0; for (; layout[count]; count++) {}
  if (!noheader) {
    for (int j = 0; j < count; j++) { if (j) putchar(' '); field(NULL, layout[j], 1, j == count - 1, wide); }
    putchar('\n');
  }
  int shown = 0;
  for (int i = 0; i < n; i++) {
    if (nonly) { int hit = 0; for (int k = 0; k < nonly; k++) if (only[k] == ps[i].pid) hit = 1; if (!hit) continue; }
    for (int j = 0; j < count; j++) { if (j) putchar(' '); field(&ps[i], layout[j], 0, j == count - 1, wide); }
    putchar('\n');
    shown++;
  }
  return nonly && !shown ? 1 : 0;
}

// ---------------------------------------------------------------------------- pgrep, pkill

static int signal_number(const char *s) {
  if (isdigit((unsigned char)*s)) return atoi(s);
  if (!strncasecmp(s, "SIG", 3)) s += 3;
  for (int i = 1; i < NSIG; i++) if (!strcasecmp(s, sys_signame[i])) return i;
  return -1;
}

static int cmd_pgrep(int argc, char **argv, int kill_them) {
  int full = 0, list = 0, list_args = 0, exact = 0, icase = 0, invert = 0, newest = 0, oldest = 0, count_only = 0, sig = SIGTERM;
  const char *delim = "\n", *pattern = NULL;
  pid_t parents[64]; int npar = 0; uid_t users[64]; int nusr = 0;
  for (int i = 1; i < argc; i++) {
    const char *a = argv[i];
    if (a[0] != '-' || !a[1]) { if (pattern) { fprintf(stderr, "%s: only one pattern can be given\n", kill_them ? "pkill" : "pgrep"); return 2; } pattern = a; continue; }
    if (kill_them && signal_number(a + 1) > 0 && !strchr("flaxivnocPudsLq", a[1])) { sig = signal_number(a + 1); continue; }
    if (!strcmp(a, "--signal") || (kill_them && !strcmp(a, "-s"))) { if (i + 1 >= argc || (sig = signal_number(argv[++i])) < 0) return 2; continue; }
    for (const char *c = a + 1; *c; c++) {
      switch (*c) {
        case 'f': full = 1; break;
        case 'l': list = 1; break;
        case 'a': list_args = 1; break;
        case 'x': exact = 1; break;
        case 'i': icase = 1; break;
        case 'v': invert = 1; break;
        case 'n': newest = 1; break;
        case 'o': oldest = 1; break;
        case 'c': count_only = 1; break;
        case 'q': break;
        case 'd': if (i + 1 < argc) delim = argv[++i]; c = " "; break;
        case 'P': case 'u': {
          char opt = *c;
          const char *v = c[1] ? c + 1 : (i + 1 < argc ? argv[++i] : "");
          char *copy = strdup(v), *save = NULL;
          for (char *t = strtok_r(copy, ",", &save); t; t = strtok_r(NULL, ",", &save)) {
            if (opt == 'P' && npar < 64) parents[npar++] = atoi(t);
            if (opt == 'u' && nusr < 64) { struct passwd *pw = getpwnam(t); users[nusr++] = pw ? pw->pw_uid : (uid_t)atoi(t); }
          }
          c = " ";
          break;
        }
        default: fprintf(stderr, "%s: unsupported option -%c\n", kill_them ? "pkill" : "pgrep", *c); return 2;
      }
      if (*c == ' ') break;
    }
  }
  if (!pattern && !npar && !nusr) { fprintf(stderr, "usage: %s [-flaxivnoc] [-P ppid] [-u user] pattern\n", kill_them ? "pkill" : "pgrep"); return 2; }
  regex_t re;
  if (pattern && regcomp(&re, pattern, REG_EXTENDED | REG_NOSUB | (icase ? REG_ICASE : 0))) { fprintf(stderr, "invalid pattern\n"); return 2; }
  int n; struct proc *ps = visible(&n);
  pid_t self = getpid();
  int hits[8192]; int nh = 0;
  for (int i = 0; i < n && nh < 8192; i++) {
    if (ps[i].pid == self || ps[i].status == SZOMB) continue;
    int ok = 1;
    if (npar) { ok = 0; for (int k = 0; k < npar; k++) if (parents[k] == ps[i].ppid) ok = 1; }
    if (ok && nusr) { ok = 0; for (int k = 0; k < nusr; k++) if (users[k] == ps[i].uid) ok = 1; }
    if (ok && pattern) {
      const char *subject = full ? ps[i].args : ps[i].comm;
      int m = regexec(&re, subject, 0, NULL, 0) == 0;
      if (m && exact) {
        regmatch_t rm; regex_t ex; char anchored[4200];
        snprintf(anchored, sizeof anchored, "^(%s)$", pattern);
        m = !regcomp(&ex, anchored, REG_EXTENDED | (icase ? REG_ICASE : 0)) && !regexec(&ex, subject, 1, &rm, 0);
      }
      ok = invert ? !m : m;
    }
    if (ok) hits[nh++] = i;
  }
  if ((newest || oldest) && nh > 1) {
    int best = hits[0];
    for (int k = 1; k < nh; k++) {
      struct proc *a = &ps[hits[k]], *b = &ps[best];
      if (newest ? (a->start_s > b->start_s || (a->start_s == b->start_s && a->pid > b->pid)) : (a->start_s < b->start_s || (a->start_s == b->start_s && a->pid < b->pid))) best = hits[k];
    }
    hits[0] = best; nh = 1;
  }
  if (count_only) { printf("%d\n", nh); return nh ? 0 : 1; }
  int failed = 0;
  for (int k = 0; k < nh; k++) {
    struct proc *p = &ps[hits[k]];
    if (kill_them) { if (kill(p->pid, sig)) { failed = 1; fprintf(stderr, "pkill: kill %d: %s\n", p->pid, strerror(errno)); } if (!list) continue; }
    if (list_args || (list && full)) printf("%d %s", p->pid, p->args);
    else if (list) printf("%d %s", p->pid, p->comm);
    else printf("%d", p->pid);
    fputs(k + 1 < nh || kill_them ? delim : "\n", stdout);
  }
  if (!kill_them && nh && strcmp(delim, "\n")) putchar('\n');
  return nh ? (failed ? 3 : 0) : 1;
}

int main(int argc, char **argv) {
  const char *name = strrchr(argv[0], '/') ? strrchr(argv[0], '/') + 1 : argv[0];
  if (!strcmp(name, "ps")) return cmd_ps(argc, argv);
  if (!strcmp(name, "pgrep")) return cmd_pgrep(argc, argv, 0);
  if (!strcmp(name, "pkill")) return cmd_pgrep(argc, argv, 1);
  fprintf(stderr, "mina-ps: run as ps, pgrep or pkill\n");
  return 2;
}
