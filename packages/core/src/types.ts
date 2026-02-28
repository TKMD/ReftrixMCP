// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Core type definitions for Reftrix
 */

import { z } from "zod";

// Search types
export const searchQuerySchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  categoryIds: z.array(z.string().uuid()).optional(),
  licenseIds: z.array(z.string().uuid()).optional(),
  tags: z.array(z.string()).optional(),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const searchResultSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    similarity: z.number(),
  })),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

export type SearchResult = z.infer<typeof searchResultSchema>;

// License types
export const licenseSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  spdxId: z.string().optional(),
  url: z.string().url().optional(),
  requiresAttribution: z.boolean().default(false),
  allowsCommercial: z.boolean().default(true),
  allowsModification: z.boolean().default(true),
});

export type License = z.infer<typeof licenseSchema>;

// Category types
export const categorySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100),
  description: z.string().optional(),
  parentId: z.string().uuid().optional(),
});

export type Category = z.infer<typeof categorySchema>;

// Robots.txt types
export interface RobotsTxtCheckResult {
  /** Whether the URL is allowed by robots.txt */
  allowed: boolean;
  /** The domain that was checked */
  domain: string;
  /** Whether the result came from cache */
  cached: boolean;
  /** Reason for the decision */
  reason: "allowed" | "disallowed" | "fetch_error" | "feature_disabled" | "override";
  /** Crawl delay in seconds (if specified in robots.txt) */
  crawlDelay?: number;
}

export const robotsTxtOptionsSchema = z.object({
  /** Whether to respect robots.txt (default: true when feature enabled) */
  respectRobotsTxt: z.boolean().optional(),
});
