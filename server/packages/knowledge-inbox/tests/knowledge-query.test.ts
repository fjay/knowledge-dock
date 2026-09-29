import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestRuntime } from "@actiondock/testing";
import queryAction from "../actions/knowledge-query.ts";

describe("knowledge.query", () => {
  it("returns empty items array when inbox directories do not exist", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-query-empty-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const result = await runtime.run(queryAction, {});
      assert.deepEqual(result.items, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid status with 400 error", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-query-status-err-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      await assert.rejects(
        () => runtime.run(queryAction, { status: "invalid_status" as any }),
        (err: any) => err.code === "INVALID_STATUS"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid limit with 400 error", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-query-limit-err-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      await assert.rejects(
        () => runtime.run(queryAction, { limit: 0 }),
        (err: any) => err.code === "INVALID_LIMIT"
      );

      await assert.rejects(
        () => runtime.run(queryAction, { limit: -5 }),
        (err: any) => err.code === "INVALID_LIMIT"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("queries candidates across pending and processed archives by exact ID or filename", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-query-id-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const pendingDir = path.join(tmpDir, "pending");
      const processedDir = path.join(tmpDir, "processed", "2026", "accepted");
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(processedDir, { recursive: true });

      // Pending file
      const pendingFile = path.join(
        pendingDir,
        "20260924-112345-a1b2c3-redis-split-brain.md"
      );
      fs.writeFileSync(
        pendingFile,
        `---
id: 20260924-a1b2c3
title: Redis Cluster Split Brain Recovery
domain: infrastructure
author: jay.wu
tags: [redis, cluster]
repos: [order-service]
created_at: '2026-09-24T11:23:45.000Z'
status: pending
---
# Redis Cluster Split Brain Recovery
Check quorum and network partition.`
      );

      // Processed file
      const processedFile = path.join(
        processedDir,
        "20260925-140000-d4e5f6-kafka-lag.md"
      );
      fs.writeFileSync(
        processedFile,
        `---
id: 20260925-d4e5f6
title: Kafka Lag Alert Remediation
domain: messaging
author: alice.chen
tags: [kafka, consumer]
repos: [message-service]
created_at: '2026-09-25T14:00:00.000Z'
archived_at: '2026-09-25T15:00:00.000Z'
status: processed
resolution: accepted
archive_note: Verified and integrated into messaging runbook
---
# Kafka Lag Alert Remediation
Inspect consumer group offset lag.`
      );

      // 1. Query by exact ID for pending doc
      const resPending = await runtime.run(queryAction, { id: "20260924-a1b2c3" });
      assert.equal(resPending.items.length, 1);
      assert.equal(resPending.items[0].id, "20260924-a1b2c3");
      assert.equal(resPending.items[0].status, "pending");
      assert.equal(resPending.items[0].author, "jay.wu");
      assert.equal(resPending.items[0].title, "Redis Cluster Split Brain Recovery");

      // 2. Query by filename with .md for processed doc
      const resProcessed = await runtime.run(queryAction, {
        id: "20260925-140000-d4e5f6-kafka-lag.md",
      });
      assert.equal(resProcessed.items.length, 1);
      assert.equal(resProcessed.items[0].id, "20260925-d4e5f6");
      assert.equal(resProcessed.items[0].status, "processed");
      assert.equal(resProcessed.items[0].resolution, "accepted");
      assert.equal(
        resProcessed.items[0].archiveNote,
        "Verified and integrated into messaging runbook"
      );
      assert.equal(resProcessed.items[0].author, "alice.chen");
      assert.equal(resProcessed.items[0].year, "2026");

      // 3. Query by filename without .md
      const resNoExt = await runtime.run(queryAction, {
        id: "20260924-112345-a1b2c3-redis-split-brain",
      });
      assert.equal(resNoExt.items.length, 1);
      assert.equal(resNoExt.items[0].id, "20260924-a1b2c3");

      // 4. Query by non-existent ID
      const resNone = await runtime.run(queryAction, { id: "non-existent-id" });
      assert.equal(resNone.items.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("queries candidates with fuzzy keyword search across title, body, tags, and archive_note", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-query-kw-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const pendingDir = path.join(tmpDir, "pending");
      const processedDir = path.join(tmpDir, "processed", "2026", "duplicate");
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(processedDir, { recursive: true });

      // Doc 1: keyword in title
      fs.writeFileSync(
        path.join(pendingDir, "20260920-100000-111111-doc-one.md"),
        `---
id: 20260920-111111
title: Postgres Connection Pooling Timeout
created_at: '2026-09-20T10:00:00.000Z'
status: pending
---
Details on pool configuration.`
      );

      // Doc 2: keyword in body
      fs.writeFileSync(
        path.join(pendingDir, "20260921-100000-222222-doc-two.md"),
        `---
id: 20260921-222222
title: JVM Garbage Collection Tuning
created_at: '2026-09-21T10:00:00.000Z'
status: pending
---
Avoid full GC pauses with G1GC parameters.`
      );

      // Doc 3: keyword in tags
      fs.writeFileSync(
        path.join(pendingDir, "20260922-100000-333333-doc-three.md"),
        `---
id: 20260922-333333
title: Network Diagnostic Guide
tags: [latency, timeout, tcp]
created_at: '2026-09-22T10:00:00.000Z'
status: pending
---
Use tcpdump and traceroute.`
      );

      // Doc 4: keyword in archive_note
      fs.writeFileSync(
        path.join(processedDir, "20260923-100000-444444-doc-four.md"),
        `---
id: 20260923-444444
title: MySQL Deadlock Investigation
created_at: '2026-09-23T10:00:00.000Z'
archived_at: '2026-09-23T11:00:00.000Z'
status: processed
resolution: duplicate
archive_note: Duplicate of KB-202608-01 covering transaction timeout
---
Details on deadlock detection.`
      );

      // Search keyword 'timeout': matches Doc 1 (title), Doc 3 (tags), Doc 4 (archive_note)
      const resTimeout = await runtime.run(queryAction, { keyword: "timeout" });
      assert.equal(resTimeout.items.length, 3);
      const matchedIds = resTimeout.items.map((i) => i.id);
      assert.ok(matchedIds.includes("20260920-111111"));
      assert.ok(matchedIds.includes("20260922-333333"));
      assert.ok(matchedIds.includes("20260923-444444"));

      // Search keyword 'g1gc': matches Doc 2 (body)
      const resBody = await runtime.run(queryAction, { keyword: "G1GC" });
      assert.equal(resBody.items.length, 1);
      assert.equal(resBody.items[0].id, "20260921-222222");

      // Search keyword 'unmatched_string': returns 0 items
      const resUnmatched = await runtime.run(queryAction, { keyword: "unmatched_xyz_123" });
      assert.equal(resUnmatched.items.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("filters candidates by author with case-insensitivity", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-query-author-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const pendingDir = path.join(tmpDir, "pending");
      fs.mkdirSync(pendingDir, { recursive: true });

      // Doc by jay.wu
      fs.writeFileSync(
        path.join(pendingDir, "20260920-100000-111111-doc.md"),
        `---
id: 20260920-111111
title: Doc by Jay
author: jay.wu
created_at: '2026-09-20T10:00:00.000Z'
status: pending
---
# Doc by Jay`
      );

      // Doc by bob.li
      fs.writeFileSync(
        path.join(pendingDir, "20260921-100000-222222-doc.md"),
        `---
id: 20260921-222222
title: Doc by Bob
author: bob.li
created_at: '2026-09-21T10:00:00.000Z'
status: pending
---
# Doc by Bob`
      );

      // Query with mixed case and spaces ' Jay.Wu '
      const resMatch = await runtime.run(queryAction, { author: " Jay.Wu " });
      assert.equal(resMatch.items.length, 1);
      assert.equal(resMatch.items[0].id, "20260920-111111");
      assert.equal(resMatch.items[0].author, "jay.wu");

      // Query with uppercase 'BOB.LI'
      const resBob = await runtime.run(queryAction, { author: "BOB.LI" });
      assert.equal(resBob.items.length, 1);
      assert.equal(resBob.items[0].id, "20260921-222222");

      // Query with non-existent author
      const resNone = await runtime.run(queryAction, { author: "charlie" });
      assert.equal(resNone.items.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("filters candidates by repo and status, and respects result limit", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-query-repo-limit-"));
    try {
      const runtime = createTestRuntime();
      runtime.config.set("KNOWLEDGE_INBOX_ROOT", tmpDir);

      const pendingDir = path.join(tmpDir, "pending");
      const processedDir = path.join(tmpDir, "processed", "2026", "accepted");
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.mkdirSync(processedDir, { recursive: true });

      // Pending 1 (order-service)
      fs.writeFileSync(
        path.join(pendingDir, "20260920-100000-111111-doc.md"),
        `---
id: 20260920-111111
title: Pending Order Doc 1
repos: [order-service]
created_at: '2026-09-20T10:00:00.000Z'
status: pending
---
Content 1`
      );

      // Pending 2 (order-service and payment-service)
      fs.writeFileSync(
        path.join(pendingDir, "20260922-100000-222222-doc.md"),
        `---
id: 20260922-222222
title: Pending Order Doc 2
repos: [order-service, payment-service]
created_at: '2026-09-22T10:00:00.000Z'
status: pending
---
Content 2`
      );

      // Processed 1 (order-service)
      fs.writeFileSync(
        path.join(processedDir, "20260923-100000-333333-doc.md"),
        `---
id: 20260923-333333
title: Processed Order Doc
repos: [order-service]
created_at: '2026-09-23T10:00:00.000Z'
archived_at: '2026-09-23T11:00:00.000Z'
status: processed
resolution: accepted
---
Content 3`
      );

      // 1. Filter by repo="order-service" and status="pending"
      const resPending = await runtime.run(queryAction, {
        repo: "order-service",
        status: "pending",
      });
      assert.equal(resPending.items.length, 2);
      assert.equal(resPending.items[0].id, "20260922-222222"); // sorted by date desc
      assert.equal(resPending.items[1].id, "20260920-111111");

      // 2. Filter by status="processed"
      const resProcessed = await runtime.run(queryAction, {
        status: "processed",
      });
      assert.equal(resProcessed.items.length, 1);
      assert.equal(resProcessed.items[0].id, "20260923-333333");

      // 3. Default status="all" returns all 3 documents
      const resAll = await runtime.run(queryAction, {
        repo: "order-service",
      });
      assert.equal(resAll.items.length, 3);
      assert.equal(resAll.items[0].id, "20260923-333333"); // most recent first

      // 4. Test limit: limit=2 returns top 2
      const resLimit = await runtime.run(queryAction, {
        repo: "order-service",
        limit: 2,
      });
      assert.equal(resLimit.items.length, 2);
      assert.equal(resLimit.items[0].id, "20260923-333333");
      assert.equal(resLimit.items[1].id, "20260922-222222");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
