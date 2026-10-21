#!/usr/bin/env python3
"""Shows each security test can fail: removes one vault check at a time, rebuilds, runs the tests
that cover it, and expects them to fail (docs/acceptance.md, "Done for the suite").

The contract source is restored from memory after every mutation, whatever happens.
"""

import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LIB = ROOT / "contracts/policy-vault/src/lib.rs"

# (name, exact text to replace, replacement, unit-test filters, sandbox-test filters)
MUTATIONS = [
    (
        "allowlist removed",
        "if !self.merchants.iter().any(|m| m.account_id == req.merchant_id) {",
        "if false {",
        ["t01"],
        ["t01_t02"],
    ),
    (
        "daily limit removed",
        "Some(total) if total <= p.daily_max.0 => {}",
        "Some(_) => {}",
        ["t04", "t12_"],
        ["t04", "t12_"],
    ),
    (
        "reservations not counted",
        ".filter(|r| r.status == OpStatus::Dispatched && r.day.map(|d| d.0) == Some(day))",
        ".filter(|_| false)",
        ["t05_t06"],
        ["t05_t06"],
    ),
    (
        "approval not bound to fields",
        "if stored.op != op {",
        "if stored.op.op_id != op.op_id {",
        ["t09"],
        ["t09"],
    ),
    (
        # The record leaving `active` is what makes a late callback a no-op. (Dropping the
        # status guard alone is an equivalent mutant: only dispatched ops ever get a callback.)
        "finished op stays active",
        "let mut rec = self.active.remove(i);",
        "let mut rec = self.active[i].clone();",
        ["t17a"],
        [],
    ),
]


def run(cmd):
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)


def tests_fail(package, filters, extra=()):
    for f in filters:
        r = run(["cargo", "test", "-p", package, *extra, f])
        if r.returncode == 0:
            return False, f
    return True, None


def main():
    only = sys.argv[1:]  # optional: names of mutations to run
    original = LIB.read_text()
    failures = []
    try:
        for name, old, new, unit, sandbox in MUTATIONS:
            if only and name not in only:
                continue
            if original.count(old) != 1:
                failures.append(f"{name}: anchor not found exactly once")
                continue
            LIB.write_text(original.replace(old, new))
            caught, survivor = tests_fail("policy-vault", unit)
            if caught and sandbox:
                if run(["make", "build"]).returncode != 0:
                    failures.append(f"{name}: mutant did not build")
                    continue
                caught, survivor = tests_fail("security-tests", sandbox, ["--test", "security"])
            status = "caught" if caught else f"SURVIVED ({survivor} still passes)"
            print(f"{name}: {status}", flush=True)
            if not caught:
                failures.append(name)
    finally:
        LIB.write_text(original)
        run(["make", "build"])
    if failures:
        sys.exit("mutants not caught: " + ", ".join(failures))
    print("all mutants caught")


if __name__ == "__main__":
    main()
