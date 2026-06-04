// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze advertised-inputSchema ↔ Zod coercion-parity regression.
 *
 * INV-SCHEMA-ENUM-004 (schema-enum-sync domain): the advertised JSON Schema
 * (`pageAnalyzeToolDefinition.inputSchema`) drives `coerceArgs` (buildCoercionMap
 * only walks the advertised `properties`). Any scalar field present in the Zod
 * `pageAnalyzeInputSchema` but ABSENT from the advertised schema cannot be
 * string→bool/number coerced, so a client that serialises it as a string
 * (e.g. `async: "true"`) reaches `pageAnalyzeInputSchema.parse` uncoerced and
 * throws a ZodError (`invalid_type`) → VALIDATION_ERROR.
 *
 * Root cause (confirmed via bootstrap-aware JSON-RPC repro): `async` (boolean)
 * was missing from the advertised schema, so `async: "true"` was never coerced.
 *
 * These tests assert the end-to-end coercion+parse contract for `async` and the
 * other previously-drifted scalar fields, plus a structural parity guard so the
 * drift cannot regress silently.
 *
 * @module tests/tools/page/analyze-advertised-schema-coercion
 */

import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { buildCoercionMap, coerceArgs } from "../../../src/middleware/args-type-coercion";
// NOTE (test-isolation / load determinism — testing-requirements.md §3):
// `analyze.tool.ts` pulls a heavy transitive module-graph (queues, workers,
// Redis, BullMQ adapters, services). Capturing `pageAnalyzeToolDefinition`
// from a *static* top-level import made this file load-sensitive: under the
// default config (`pool: "forks"`, `fileParallelism: true`) the module's
// side-effecting graph could still be mid-evaluation when this test module's
// top-level body ran, so `pageAnalyzeToolDefinition.inputSchema.properties`
// was occasionally observed partially → the forward-compat SSOT parity guard
// reported spurious `missing=[...]`. We decouple by importing the heavy module
// via an *awaited dynamic import inside `beforeAll`*: the dynamic-import promise
// only resolves after the entire module body + its transitive deps finish
// evaluating, so the advertised schema is fully materialised before any test
// reads it. The lightweight Zod canonical schema (`input.schemas`, Zod-only)
// stays a static import — it is the load-light T1 SSOT and carries no race.
import { pageAnalyzeInputSchema } from "../../../src/tools/page/input.schemas";

// Populated in beforeAll once the heavy `analyze.tool.ts` module-graph is fully
// evaluated. Declared as mutable bindings so the deterministically-loaded
// advertised schema is shared across every test/helper below.
let advertisedSchema: Record<string, unknown>;
let advertisedProps: Record<string, unknown>;

beforeAll(async () => {
  // Awaited dynamic import guarantees full module-graph evaluation (incl. the
  // heavy transitive side-effects) before the advertised schema is captured.
  const mod = await import("../../../src/tools/page/analyze.tool");
  // Touch the handler export to mirror the original "ensure module side-effects
  // load" intent (no-op reference; the awaited import already forces eval).
  void mod.pageAnalyzeHandler;
  advertisedSchema = mod.pageAnalyzeToolDefinition.inputSchema as Record<string, unknown>;
  advertisedProps = (advertisedSchema.properties ?? {}) as Record<string, unknown>;
});

/**
 * Unwrap ZodOptional / ZodDefault / ZodEffects wrappers to reach the underlying
 * scalar/object type.
 *
 * UB3 (TPA-L-02 + TDA-L-02 convergent): `pageAnalyzeFrameCaptureOptionsSchema`
 * (`input.schemas.ts:281` `.object` → `:333` `.refine`) is a ZodObject wrapped
 * in ZodEffects. If `unwrapZod` does not strip ZodEffects, the recursion below
 * silently skips the whole `frame_capture_options` sub-tree → its coercible
 * scalars are never enumerated → the forward-compat guard goes vacuously GREEN.
 * ZodEffects keeps its inner schema in `_def.schema` (`.refine`/`.transform`);
 * we also fall back to `_def.innerType` for robustness across Zod builds.
 */
function unwrapZod(schema: z.ZodTypeAny): z.ZodTypeAny {
  let cur: z.ZodTypeAny = schema;
  for (;;) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const def = (cur as any)._def;
    const typeName = def?.typeName as string | undefined;
    if (typeName === "ZodOptional" || typeName === "ZodDefault") {
      cur = def.innerType as z.ZodTypeAny;
    } else if (typeName === "ZodEffects") {
      // `.refine()` / `.transform()` wrap the inner schema under `_def.schema`;
      // some builds expose `_def.innerType` — fall back for robustness (UB3).
      cur = (def.schema ?? def.innerType) as z.ZodTypeAny;
    } else {
      return cur;
    }
  }
}

/**
 * Derive, directly from the Zod canonical schema (T1), the set of top-level
 * fields whose effective type is boolean / number — i.e. the fields that
 * REQUIRE string→scalar coercion (object fields are recursed by coerceArgs,
 * scalars are not). This is the SSOT for the forward-compat parity guard so a
 * future Zod field addition cannot silently re-introduce the coercion drift.
 */
function deriveCoercibleTopLevelZodFields(): Record<string, "boolean" | "number"> {
  const shape = (pageAnalyzeInputSchema as z.ZodObject<z.ZodRawShape>).shape;
  const out: Record<string, "boolean" | "number"> = {};
  for (const [key, value] of Object.entries(shape)) {
    const inner = unwrapZod(value as z.ZodTypeAny);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const typeName = (inner as any)._def?.typeName as string | undefined;
    if (typeName === "ZodBoolean") out[key] = "boolean";
    else if (typeName === "ZodNumber") out[key] = "number";
  }
  return out;
}

/**
 * Recursively derive, from the Zod canonical schema (T1 SSOT), EVERY coercible
 * (boolean/number) scalar reachable through nested ZodObjects, as a dotted path
 * (e.g. `motionOptions.video_options.timeout`). This is the SSOT for the
 * forward-compat NESTED parity guard so a new nested boolean/number added to any
 * `*OptionsSchema` without an advertised-schema property is caught at CI (RED).
 *
 * Contracts:
 * - UB3: `unwrapZod` strips ZodEffects (e.g. `frame_capture_options`'s `.refine`)
 *   so its sub-tree is not silently skipped.
 * - UB2 (TPA-L-01): ZodArray is EXCLUDED from leaf walking — symmetric with
 *   `coerceArgs` `applyCoercion` (`args-type-coercion.ts:147` `!Array.isArray`)
 *   which does NOT recurse into arrays. Without this exclusion, array element
 *   scalars (`runtime_options.scroll_positions`) / array-of-object leaves
 *   (`responsiveOptions.viewports[*]`) would land in the guard's `missing` set
 *   (advertised carries no array-element property) → false RED post-fix.
 */
function deriveCoercibleNestedZodFields(): Record<string, "boolean" | "number"> {
  const out: Record<string, "boolean" | "number"> = {};

  function walk(schema: z.ZodTypeAny, prefix: string): void {
    const inner = unwrapZod(schema);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const typeName = (inner as any)._def?.typeName as string | undefined;

    if (typeName === "ZodBoolean") {
      out[prefix] = "boolean";
      return;
    }
    if (typeName === "ZodNumber") {
      out[prefix] = "number";
      return;
    }
    // UB2: ZodArray is excluded (engine does not recurse arrays). Do not record
    // it as a leaf and do not descend into its element type.
    if (typeName === "ZodArray") {
      return;
    }
    if (typeName === "ZodObject") {
      const shape = (inner as z.ZodObject<z.ZodRawShape>).shape;
      for (const [key, value] of Object.entries(shape)) {
        const path = prefix ? `${prefix}.${key}` : key;
        walk(value as z.ZodTypeAny, path);
      }
    }
    // Other leaf types (ZodString / ZodEnum / etc.) are not coercible → ignore.
  }

  const rootShape = (pageAnalyzeInputSchema as z.ZodObject<z.ZodRawShape>).shape;
  for (const [key, value] of Object.entries(rootShape)) {
    walk(value as z.ZodTypeAny, key);
  }
  return out;
}

/**
 * Constraint info SSOT-derived from a coercible Zod scalar (UB4 / TDA-L-01).
 */
interface ZodConstraintInfo {
  type: "boolean" | "number";
  default?: number;
  minimum?: number;
  maximum?: number;
}

/**
 * Extract `default` / `minimum` / `maximum` for a single (already-unwrapped-aware)
 * Zod scalar. ZodNumber min/max live in `_def.checks`; ZodDefault default is the
 * value returned by `_def.defaultValue()`. We must read the default from the
 * OUTER schema (the ZodDefault wrapper) and the min/max from the INNER ZodNumber,
 * so we walk wrappers manually here rather than via `unwrapZod`.
 */
function extractScalarConstraints(schema: z.ZodTypeAny): ZodConstraintInfo | null {
  let cur: z.ZodTypeAny = schema;
  let defaultValue: number | undefined;
  // Strip wrappers, capturing the default from a ZodDefault if present.
  for (;;) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const def = (cur as any)._def;
    const typeName = def?.typeName as string | undefined;
    if (typeName === "ZodOptional") {
      cur = def.innerType as z.ZodTypeAny;
    } else if (typeName === "ZodDefault") {
      const dv = def.defaultValue?.();
      if (typeof dv === "number") defaultValue = dv;
      cur = def.innerType as z.ZodTypeAny;
    } else if (typeName === "ZodEffects") {
      cur = (def.schema ?? def.innerType) as z.ZodTypeAny;
    } else {
      break;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const innerDef = (cur as any)._def;
  const innerType = innerDef?.typeName as string | undefined;
  if (innerType === "ZodBoolean") {
    return { type: "boolean", default: defaultValue };
  }
  if (innerType === "ZodNumber") {
    let minimum: number | undefined;
    let maximum: number | undefined;
    const checks: Array<{ kind: string; value?: number }> = innerDef.checks ?? [];
    for (const c of checks) {
      if (c.kind === "min" && typeof c.value === "number") minimum = c.value;
      else if (c.kind === "max" && typeof c.value === "number") maximum = c.value;
    }
    return { type: "number", default: defaultValue, minimum, maximum };
  }
  return null;
}

/**
 * Recursively derive constraints (default/minimum/maximum) for every coercible
 * nested Zod scalar (UB4 / TDA-L-01). Mirrors `deriveCoercibleNestedZodFields`
 * traversal (same ZodEffects unwrap + ZodArray exclusion contracts).
 */
function deriveNestedZodConstraints(): Record<string, ZodConstraintInfo> {
  const out: Record<string, ZodConstraintInfo> = {};

  function walk(schema: z.ZodTypeAny, prefix: string): void {
    const scalar = extractScalarConstraints(schema);
    if (scalar) {
      out[prefix] = scalar;
      return;
    }
    const inner = unwrapZod(schema);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const typeName = (inner as any)._def?.typeName as string | undefined;
    if (typeName === "ZodArray") return; // UB2
    if (typeName === "ZodObject") {
      const shape = (inner as z.ZodObject<z.ZodRawShape>).shape;
      for (const [key, value] of Object.entries(shape)) {
        const path = prefix ? `${prefix}.${key}` : key;
        walk(value as z.ZodTypeAny, path);
      }
    }
  }

  const rootShape = (pageAnalyzeInputSchema as z.ZodObject<z.ZodRawShape>).shape;
  for (const [key, value] of Object.entries(rootShape)) {
    walk(value as z.ZodTypeAny, key);
  }
  return out;
}

/**
 * Traverse the advertised JSON Schema and collect default/minimum/maximum for
 * every leaf at its dotted path (UB4 helper). Used to diff against
 * `deriveNestedZodConstraints()`.
 */
function collectAdvertisedNestedConstraints(
  schema: Record<string, unknown>
): Map<string, { default?: number; minimum?: number; maximum?: number; type?: string }> {
  const map = new Map<
    string,
    { default?: number; minimum?: number; maximum?: number; type?: string }
  >();

  function walk(node: Record<string, unknown>, prefix: string): void {
    const props = node.properties as Record<string, Record<string, unknown>> | undefined;
    if (!props) return;
    for (const [key, prop] of Object.entries(props)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const type = prop.type as string | undefined;
      if (type === "object" && prop.properties) {
        walk(prop, path);
      } else if (type === "number" || type === "integer" || type === "boolean") {
        map.set(path, {
          type,
          default: typeof prop.default === "number" ? (prop.default as number) : undefined,
          minimum: typeof prop.minimum === "number" ? (prop.minimum as number) : undefined,
          maximum: typeof prop.maximum === "number" ? (prop.maximum as number) : undefined,
        });
      }
      // arrays / strings / enums: ignored (not coercible scalars)
    }
  }

  walk(schema, "");
  return map;
}

function coerceThenParse(
  rawArgs: Record<string, unknown>
): ReturnType<typeof pageAnalyzeInputSchema.safeParse> {
  const coerced = coerceArgs(rawArgs, advertisedSchema);
  return pageAnalyzeInputSchema.safeParse(coerced);
}

describe("page.analyze advertised-schema coercion parity (INV-SCHEMA-ENUM-004)", () => {
  // --- the regression bug itself -------------------------------------------
  it('coerces string async:"true" to boolean and parses (the reported bug)', () => {
    const result = coerceThenParse({ url: "https://example.com", async: "true" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.async).toBe(true);
    }
  });

  it('coerces string async:"false" to boolean false', () => {
    const result = coerceThenParse({ url: "https://example.com", async: "false" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.async).toBe(false);
    }
  });

  it("coerces the exact live failing payload {url, summary, async, timeout} all-string", () => {
    const result = coerceThenParse({
      url: "https://example.com",
      summary: "true",
      async: "true",
      timeout: "60000",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.async).toBe(true);
      expect(result.data.summary).toBe(true);
      expect(result.data.timeout).toBe(60000);
    }
  });

  it("still accepts a real boolean async (no regression for typed callers)", () => {
    const result = coerceThenParse({ url: "https://example.com", async: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.async).toBe(true);
    }
  });

  // --- other previously-drifted scalar fields ------------------------------
  it("coerces previously-drifted string scalar fields (partial_results / auto_retry / max_retries / per-phase timeouts)", () => {
    const result = coerceThenParse({
      url: "https://example.com",
      partial_results: "false",
      auto_retry: "false",
      respect_robots_txt: "true",
      max_retries: "2",
      layoutTimeout: "90000",
      motionTimeout: "120000",
      qualityTimeout: "30000",
      timeout_strategy: "strict",
      layout_first: "always",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.partial_results).toBe(false);
      expect(result.data.auto_retry).toBe(false);
      expect(result.data.respect_robots_txt).toBe(true);
      expect(result.data.max_retries).toBe(2);
      expect(result.data.layoutTimeout).toBe(90000);
      expect(result.data.motionTimeout).toBe(120000);
      expect(result.data.qualityTimeout).toBe(30000);
      expect(result.data.timeout_strategy).toBe("strict");
      expect(result.data.layout_first).toBe("always");
    }
  });

  it("coerces nested narrativeOptions / visionOptions string scalars", () => {
    const result = coerceThenParse({
      url: "https://example.com",
      narrativeOptions: { enabled: "false", includeVision: "false" },
      visionOptions: { visionForceCpu: "true", visionTimeoutMs: "90000" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.narrativeOptions?.enabled).toBe(false);
      expect(result.data.narrativeOptions?.includeVision).toBe(false);
      expect(result.data.visionOptions?.visionForceCpu).toBe(true);
      expect(result.data.visionOptions?.visionTimeoutMs).toBe(90000);
    }
  });

  // --- structural parity guard (prevents silent re-drift) ------------------
  it("every Zod top-level scalar/enum field is present in the advertised inputSchema", () => {
    // Top-level fields whose Zod type is boolean / number / enum(string) — i.e.
    // the fields that REQUIRE coercion coverage. Object fields are recursed by
    // coerceArgs, scalars are not, so these MUST appear in the advertised schema.
    const requiredScalarFields = [
      "summary",
      "async",
      "timeout",
      "timeout_strategy",
      "partial_results",
      "layoutTimeout",
      "motionTimeout",
      "qualityTimeout",
      "auto_retry",
      "max_retries",
      "layout_first",
      "auto_timeout",
      "respect_robots_txt",
      "waitUntil",
      "auto_snapshot",
    ];
    const missing = requiredScalarFields.filter((f) => !(f in advertisedProps));
    expect(missing).toEqual([]);
  });

  it("the previously-missing top-level fields are now advertised", () => {
    for (const f of [
      "async",
      "narrativeOptions",
      "visionOptions",
      "timeout_strategy",
      "partial_results",
      "layoutTimeout",
      "motionTimeout",
      "qualityTimeout",
      "auto_retry",
      "max_retries",
      "layout_first",
      "respect_robots_txt",
    ]) {
      expect(advertisedProps).toHaveProperty(f);
    }
  });

  // --- forward-compat drift guard (SSOT-derived, not hardcoded) ------------
  it("every coercible (boolean/number) top-level Zod field is coerced by the advertised schema (forward-compat, SSOT-derived)", () => {
    // T1 SSOT: derive the coercion requirement straight from the Zod canonical
    // schema rather than a hardcoded list, so a NEW boolean/number field added
    // to pageAnalyzeInputSchema without an advertised-schema property is caught
    // at CI time (it would land here as a coverage gap → RED).
    const zodCoercible = deriveCoercibleTopLevelZodFields();
    const advertisedCoercionMap = buildCoercionMap(advertisedSchema);

    const missing: string[] = [];
    const typeMismatch: string[] = [];
    for (const [field, expectedType] of Object.entries(zodCoercible)) {
      const advertisedType = advertisedCoercionMap.get(field);
      if (advertisedType === undefined) missing.push(field);
      else if (advertisedType !== expectedType) {
        typeMismatch.push(`${field}: advertised=${advertisedType} zod=${expectedType}`);
      }
    }

    expect(missing).toEqual([]);
    expect(typeMismatch).toEqual([]);
    // sanity: the regression-target `async` must be in the derived SSOT set
    expect(zodCoercible).toHaveProperty("async", "boolean");
  });

  // === PR-L2 (CO-ASYNC-03): NESTED scalar coercion parity ===================

  // --- (a) regression: nested string scalars coerce + parse PASS -----------
  // These representative cases are hardcoded (NOT it.each-driven) per plan §4(a)
  // (UB5): the exhaustive field-by-field follow-up is owned by the SSOT-derived
  // nested guard below; hardcoding the representatives keeps a SECOND, derive-
  // helper-INDEPENDENT verification path so a bug in `deriveCoercibleNestedZodFields`
  // (e.g. a missed ZodEffects unwrap) cannot vacuously pass both at once.
  it("coerces nested layoutOptions string scalars (perSectionVision/visionBatchSize/scrollVision/scrollVisionMaxCaptures)", () => {
    const result = coerceThenParse({
      url: "https://example.com",
      layoutOptions: {
        perSectionVision: "false",
        visionBatchSize: "7",
        scrollVision: "false",
        scrollVisionMaxCaptures: "12",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.layoutOptions?.perSectionVision).toBe(false);
      expect(result.data.layoutOptions?.visionBatchSize).toBe(7);
      expect(result.data.layoutOptions?.scrollVision).toBe(false);
      expect(result.data.layoutOptions?.scrollVisionMaxCaptures).toBe(12);
    }
  });

  it("coerces visionOptions.visionFallbackToHtmlOnly string scalar", () => {
    const result = coerceThenParse({
      url: "https://example.com",
      visionOptions: { visionFallbackToHtmlOnly: "false" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.visionOptions?.visionFallbackToHtmlOnly).toBe(false);
    }
  });

  it("coerces deeply-nested motionOptions.video_options + webgl/runtime string scalars", () => {
    const result = coerceThenParse({
      url: "https://example.com",
      motionOptions: {
        detection_mode: "video",
        detect_webgl_animations: "false",
        video_options: {
          timeout: "30000",
          record_duration: "12000",
          move_mouse: "false",
          viewport: { width: "1280", height: "720" },
          frame_analysis: { fps: "15", min_motion_duration_ms: "60" },
        },
        runtime_options: { wait_for_animations: "4000" },
        webgl_animation_options: { sample_frames: "60", timeout_ms: "90000" },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.motionOptions?.detect_webgl_animations).toBe(false);
      expect(result.data.motionOptions?.video_options?.timeout).toBe(30000);
      expect(result.data.motionOptions?.video_options?.record_duration).toBe(12000);
      expect(result.data.motionOptions?.video_options?.move_mouse).toBe(false);
      expect(result.data.motionOptions?.video_options?.viewport?.width).toBe(1280);
      expect(result.data.motionOptions?.video_options?.viewport?.height).toBe(720);
      expect(result.data.motionOptions?.video_options?.frame_analysis?.fps).toBe(15);
      expect(result.data.motionOptions?.video_options?.frame_analysis?.min_motion_duration_ms).toBe(
        60
      );
      expect(result.data.motionOptions?.runtime_options?.wait_for_animations).toBe(4000);
      expect(result.data.motionOptions?.webgl_animation_options?.sample_frames).toBe(60);
      expect(result.data.motionOptions?.webgl_animation_options?.timeout_ms).toBe(90000);
    }
  });

  // --- (c) forward-compat NESTED drift guard (SSOT-derived) ----------------
  it("every coercible (boolean/number) NESTED Zod field is coerced by the advertised schema (forward-compat, SSOT-derived)", () => {
    const zodCoercible = deriveCoercibleNestedZodFields();
    const advertisedCoercionMap = buildCoercionMap(advertisedSchema);
    const missing: string[] = [];
    const typeMismatch: string[] = [];
    for (const [path, expectedType] of Object.entries(zodCoercible)) {
      const advType = advertisedCoercionMap.get(path);
      if (advType === undefined) missing.push(`${path} (${expectedType})`);
      else if (advType !== expectedType)
        typeMismatch.push(`${path}: adv=${advType} zod=${expectedType}`);
    }
    expect(missing).toEqual([]);
    expect(typeMismatch).toEqual([]);
    // UB3 non-vacuity meta-assert: guarantee the leaf walk actually enumerated
    // the full coercible set (incl. the 21 gap fields). Without ZodEffects unwrap
    // (frame_capture_options sub-tree) or with a broken recursion, zodCoercible
    // would shrink → missing=[] → vacuous PASS. ≥21 structurally rules that out.
    expect(Object.keys(zodCoercible).length).toBeGreaterThanOrEqual(21);
    // sanity anchors: representative gap fields present post-fix
    expect(zodCoercible).toHaveProperty("layoutOptions.perSectionVision", "boolean");
    expect(zodCoercible).toHaveProperty("motionOptions.video_options.timeout", "number");
  });

  // --- (UB2) ZodArray exclusion (symmetry with engine array-non-recursion) --
  it("excludes ZodArray leaves from nested derivation (symmetry with coerceArgs array-non-recursion)", () => {
    const zodCoercible = deriveCoercibleNestedZodFields();
    // runtime_options.scroll_positions: z.array(z.number()) — element scalar excluded
    expect(zodCoercible).not.toHaveProperty("motionOptions.runtime_options.scroll_positions");
    // responsiveOptions.viewports: z.array(z.object(...)) — array-of-object leaves excluded
    expect(Object.keys(zodCoercible).some((p) => p.startsWith("responsiveOptions.viewports"))).toBe(
      false
    );
  });

  // --- (UB4 / TDA-L-01) constraint (default/minimum/maximum) SSOT-diff ------
  // Scope: the 21 nested scalar paths THIS PR (PR-L2) hand-transcribes into the
  // advertised schema, PLUS the 3 pre-existing already-advertised fields whose
  // advertised default was aligned to the Zod canonical (T1 SSOT) by the
  // L-tracked defense-in-depth bundle (FIND-IMPL-L2-DRIFT-01). The constraint
  // values for all of these fields are authored in the advertised schema, so
  // they must match the Zod canonical — `deriveNestedZodConstraints` derives the
  // expectations straight from Zod, catching any hand-transcription drift at CI.
  //
  // FIND-IMPL-L2-DRIFT-01 closure (was IO ruling "do not touch already-advertised
  // fields"): the 3 pre-existing fields below previously carried a benign
  // advertised↔Zod default drift (display-hint only; the coercion engine never
  // reads the advertised `default`, runtime default resolution is done by the Zod
  // canonical). They are now aligned (maxPatterns 100→500, motionOptions.timeout
  // 180000→300000, js_animation_options.waitTime 1000→2000) AND folded into this
  // SSOT-diff scope so future drift on them is also CI-detected (drift guard
  // extension). T1 SSOT = `input.schemas.ts` (maxPatterns:477, motionOptions.timeout:599,
  // jsAnimationOptionsSchema.waitTime:446).
  const PR_L2_ADDED_NUMBER_PATHS = [
    "layoutOptions.visionBatchSize",
    "layoutOptions.scrollVisionMaxCaptures",
    "motionOptions.video_options.timeout",
    "motionOptions.video_options.record_duration",
    "motionOptions.video_options.viewport.width",
    "motionOptions.video_options.viewport.height",
    "motionOptions.video_options.frame_analysis.fps",
    "motionOptions.video_options.frame_analysis.change_threshold",
    "motionOptions.video_options.frame_analysis.min_motion_duration_ms",
    "motionOptions.video_options.frame_analysis.gap_tolerance_ms",
    "motionOptions.runtime_options.wait_for_animations",
    "motionOptions.webgl_animation_options.sample_frames",
    "motionOptions.webgl_animation_options.sample_interval_ms",
    "motionOptions.webgl_animation_options.change_threshold",
    "motionOptions.webgl_animation_options.timeout_ms",
    // FIND-IMPL-L2-DRIFT-01: pre-existing advertised fields, aligned + drift-guarded
    "motionOptions.maxPatterns",
    "motionOptions.timeout",
    "motionOptions.js_animation_options.waitTime",
  ];

  it("PR-L2-added nested advertised number constraints (default/minimum/maximum) match Zod canonical (SSOT-derived, UB4/TDA-L-01)", () => {
    const zodConstraints = deriveNestedZodConstraints();
    const advConstraints = collectAdvertisedNestedConstraints(advertisedSchema);
    const drift: string[] = [];
    const notFound: string[] = [];
    for (const path of PR_L2_ADDED_NUMBER_PATHS) {
      const zc = zodConstraints[path];
      const ac = advConstraints.get(path);
      // both sides MUST exist (also guards against a typo in the path list)
      if (zc === undefined) {
        notFound.push(`zod:${path}`);
        continue;
      }
      if (ac === undefined) {
        notFound.push(`adv:${path}`);
        continue;
      }
      for (const k of ["default", "minimum", "maximum"] as const) {
        if (zc[k] !== undefined && ac[k] !== zc[k]) {
          drift.push(`${path}.${k}: adv=${ac[k]} zod=${zc[k]}`);
        }
      }
    }
    expect(notFound).toEqual([]);
    expect(drift).toEqual([]);
  });
});
