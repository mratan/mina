"""One-shot broker requests. Tokens are not instance grants or proof of human identity."""
import secrets
import threading
import time

PROTOCOL = 'mina-confirmation-v1'
MUTATION_OP = 'mutate_v2'  # v2 also enforces broker-resident admission budgets


class Confirmations:
    def __init__(self, clock=time.monotonic, ttl_s=900, max_pending=1024, per_owner=64):
        self.pending = {}
        self.lock = threading.Lock()
        self.clock, self.ttl_s = clock, ttl_s
        self.max_pending, self.per_owner = max_pending, per_owner

    def prune(self):
        for token, saved in list(self.pending.items()):
            if saved[2] <= self.clock():
                del self.pending[token]

    def issue(self, owner, signature):
        with self.lock:
            self.prune()
            matching = next((k for k, v in self.pending.items() if v[:2] == (owner, signature)), None)
            if matching:
                token = matching
            else:
                if len(self.pending) >= self.max_pending or sum(v[0] == owner for v in self.pending.values()) >= self.per_owner:
                    raise ValueError('Pending confirmation limit reached; no action started. Existing requests remain valid until expiry.')
                token = secrets.token_urlsafe(32)
                self.pending[token] = (owner, signature, self.clock() + self.ttl_s, time.time() + self.ttl_s)
            return {'protocol': PROTOCOL, 'challenge': token, 'request_digest': signature,
                    'expires_at': self.pending[token][3]}

    def consume(self, token, owner, signature):
        with self.lock:
            self.prune()
            saved = self.pending.get(token) if isinstance(token, str) else None
            if not saved or saved[0] != owner:
                raise ValueError('Confirmation is missing, expired, already used, or belongs to another session.')
            del self.pending[token]
            if saved[1] != signature:
                raise ValueError('Confirmation does not match this request or the current policy.')
