// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Type-level equality for pairing a hand-written type with a `z.infer` type (types only: nothing
 * here reaches runtime). `DeepSame<A, B>` is `true` when both describe the same object: the same
 * keys, the same optional keys and the same value types, at every level. `| undefined` on a value
 * is ignored because `z.infer` adds it to optional keys under `exactOptionalPropertyTypes`.
 * `any` on either side is never the same as anything (it would match every shape).
 * The controls at the bottom fail typecheck when the helper stops telling the cases apart.
 * Do not use it for a type that holds a union of objects or a function type: both compare as
 * `true` whatever they contain (see the pinned limit at the bottom).
 *
 * 手書きの型と `z.infer` の型を結びつけるための型レベル比較(runtime には何も出ない)。
 * 各階層で key・optional な key・値の型が一致するときだけ `true`。値の `| undefined` は無視する。
 * object の union と関数型には使わない(中身に関係なく `true` になる。末尾の limit を参照)。
 */

type IsAny<T> = 0 extends 1 & T ? true : false;
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];
type NoUndef<T> = Exclude<T, undefined>;
type Both<A extends boolean, B extends boolean> = A extends true
  ? B extends true
    ? true
    : false
  : false;
type SameSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AllTrue<T> = [T] extends [true] ? true : false;

export type DeepSame<A, B> =
  IsAny<A> extends true
    ? false
    : IsAny<B> extends true
      ? false
      : [NoUndef<A>] extends [object]
        ? [NoUndef<B>] extends [object]
          ? Both<
              Both<
                SameSet<keyof NoUndef<A>, keyof NoUndef<B>>,
                SameSet<OptionalKeys<NoUndef<A>>, OptionalKeys<NoUndef<B>>>
              >,
              AllTrue<
                {
                  [K in keyof NoUndef<A>]-?: K extends keyof NoUndef<B>
                    ? DeepSame<NoUndef<A>[K], NoUndef<B>[K]>
                    : false;
                }[keyof NoUndef<A>]
              >
            >
          : false
        : [NoUndef<B>] extends [object]
          ? false
          : SameSet<NoUndef<A>, NoUndef<B>>;

/** Compile error unless `T` is `true`. */
export type Assert<T extends true> = T;

// Controls (positive): optional-vs-`| undefined`, nested objects, equal shapes.
export type DeepSameControlEqual = Assert<
  DeepSame<
    { a?: number; n?: { b: string; c?: number } },
    { a?: number | undefined; n?: { b: string; c?: number | undefined } | undefined }
  >
>;
// Controls (negative): each must be `false`, so `Assert<Not<...>>` compiles only while the helper rejects it.
type Not<T extends boolean> = T extends true ? false : true;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- type-level control: `any` is the case under test
export type DeepSameControlAny = Assert<Not<DeepSame<{ a: any }, { a: number }>>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- type-level control: `any` is the case under test
export type DeepSameControlAnyOther = Assert<Not<DeepSame<{ a: number }, { a: any }>>>;
export type DeepSameControlExtraKey = Assert<
  Not<DeepSame<{ a: number }, { a: number; b: number }>>
>;
export type DeepSameControlOptional = Assert<Not<DeepSame<{ a?: number }, { a: number }>>>;
export type DeepSameControlNestedOptional = Assert<
  Not<DeepSame<{ n: { b: string; c?: number } }, { n: { b: string; c: number } }>>
>;
export type DeepSameControlSecondLevelKey = Assert<
  Not<DeepSame<{ n: { b: string } }, { n: { b: string; extra: string } }>>
>;
export type DeepSameControlValueType = Assert<Not<DeepSame<{ a: number }, { a: string }>>>;
// Limit (pinned, not endorsed): object unions and function types compare as `true` whatever their members
// are (`keyof` of a union is the common keys only; a function has no keys). If this line stops
// compiling, `DeepSame` learned to tell them apart: update the header and delete the pin.
export type DeepSameLimitUnion = Assert<DeepSame<{ a: 1 } | { b: 2 }, { a: 1 } | { c: 3 }>>;
