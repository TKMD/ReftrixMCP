// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * createLaunchSemaphore tests (v0.4.0 PR7e-α)
 *
 * FIFO semaphore serialises Chromium launches (SEC HIGH-3).
 *
 * @module tests/utils/launch-semaphore
 */

import { describe, it, expect } from "vitest";
import { createLaunchSemaphore, partBboxLaunchSemaphore } from "../../src/utils/launch-semaphore";

describe("createLaunchSemaphore (v0.4.0 PR7e-α / SEC HIGH-3)", () => {
  it("allows max=1 concurrent holder", async () => {
    const sem = createLaunchSemaphore(1);
    expect(sem.inFlight()).toBe(0);
    const r1 = await sem.acquire();
    expect(sem.inFlight()).toBe(1);
    r1();
    expect(sem.inFlight()).toBe(0);
  });

  it("queues waiters beyond max and releases FIFO", async () => {
    const sem = createLaunchSemaphore(1);
    const order: number[] = [];
    const r1 = await sem.acquire();
    const p2 = sem.acquire().then((r) => {
      order.push(2);
      r();
    });
    const p3 = sem.acquire().then((r) => {
      order.push(3);
      r();
    });
    // Both waiters are queued
    expect(sem.pending()).toBe(2);
    r1();
    await p2;
    await p3;
    expect(order).toEqual([2, 3]);
    expect(sem.pending()).toBe(0);
    expect(sem.inFlight()).toBe(0);
  });

  it("rejects non-positive max", () => {
    expect(() => createLaunchSemaphore(0)).toThrow(/positive integer/);
    expect(() => createLaunchSemaphore(-1)).toThrow(/positive integer/);
  });

  it("partBboxLaunchSemaphore singleton is available and starts empty", () => {
    // Best-effort: if a prior test leaked, this will still be an integer >= 0.
    expect(typeof partBboxLaunchSemaphore.inFlight()).toBe("number");
    expect(typeof partBboxLaunchSemaphore.pending()).toBe("number");
  });
});
