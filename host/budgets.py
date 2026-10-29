"""Broker-resident admission accounting. Disk receipts are recovery evidence, never an authority source."""
import copy
import threading


class BudgetExceeded(Exception):
    pass


class BudgetUnknown(Exception):
    pass


def limits(config):
    if 'instance_budget' not in config:
        return None
    value = config['instance_budget']
    keys = {'max_admissions', 'max_reserved_s'}
    if not isinstance(value, dict) or not value or set(value) - keys:
        raise ValueError('instance_budget must contain max_admissions, max_reserved_s, or both.')
    if any(type(v) is not int or v < 0 for v in value.values()):
        raise ValueError('Instance budget limits must be nonnegative integers, not booleans or fractional values.')
    return dict(value)


def zero():
    return {'admissions': 0, 'reserved_s': 0}


class AdmissionBudgets:
    def __init__(self):
        self.records = {}
        self.lock = threading.RLock()

    def open(self, owner):
        with self.lock:
            # Only native session creation can establish a complete zero baseline. Reopening never resets it.
            self.records.setdefault(owner, {'coverage': 'complete', 'used': zero(), 'workloads': {}})

    def _record(self, owner):
        return self.records.setdefault(owner, {'coverage': 'unknown', 'used': zero(), 'workloads': {}})

    def status(self, owner):
        with self.lock:
            return copy.deepcopy(self._record(owner))

    def _check(self, record, workload, cost, instance_limits, workload_limits):
        if type(cost) is not int or cost < 1:
            raise ValueError('Admission runtime reservation must be a positive integer.')
        if record['coverage'] != 'complete' and (instance_limits is not None or workload_limits is not None):
            raise BudgetUnknown('Instance accounting predates this broker process. Budgeted launches are blocked; disk history cannot reset the allowance.')
        for label, used, cap in [('instance', record['used'], instance_limits),
                                 (workload, record['workloads'].get(workload, zero()), workload_limits)]:
            if cap is None:
                continue
            for key, amount, limit_key in [('admissions', 1, 'max_admissions'), ('reserved_s', cost, 'max_reserved_s')]:
                if limit_key in cap and used[key] + amount > cap[limit_key]:
                    raise BudgetExceeded(f'{label} budget exhausted: {key} used={used[key]}, requested={amount}, ceiling={cap[limit_key]}. An operator must authorize a higher ceiling; counters do not reset.')

    def check(self, owner, workload, cost, instance_limits, workload_limits):
        with self.lock:
            self._check(self._record(owner), workload, cost, instance_limits, workload_limits)

    def admit(self, owner, workload, cost, instance_limits, workload_limits, admission_id, journal, policy_guard):
        with self.lock:
            policy_guard()  # recheck after waiting for this lock, not only before confirmation
            record = self._record(owner)
            self._check(record, workload, cost, instance_limits, workload_limits)
            used = record['workloads'].setdefault(workload, zero())
            for counts in (record['used'], used):
                counts['admissions'] += 1
                counts['reserved_s'] += cost
            receipt = {'id': admission_id, 'coverage': record['coverage'], 'reserved_s': cost,
                       'instance_used': dict(record['used']), 'workload_used': dict(used),
                       'instance_limits': instance_limits, 'workload_limits': workload_limits}
            # Charge first. A journal or launch error cannot silently refund an uncertain admission.
            journal(copy.deepcopy(receipt))
            return copy.deepcopy(receipt)
