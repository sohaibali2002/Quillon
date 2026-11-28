// Procurement-integrity attestation and document origin policy.
//
// Assets: the offeror's own proposal, the RFP, and the debriefing material it
// lawfully holds. The abuse case this module exists for is a user feeding in a
// competitor's proposal or source-selection information obtained improperly,
// which the Procurement Integrity Act forbids. Every document therefore needs
// an explicit attestation bound to a hash of its own text, an origin tag, and a
// protective-order gate that keeps sealed material out of the shared corpus.

import { createHash } from "node:crypto";

export type DocumentKind = "proposal" | "rfp" | "debrief" | "awardee_excerpt" | "protests" | "other";

export type DocumentOrigin =
  | "offeror"
  | "offeror_counsel"
  | "agency_debrief"
  | "agency_notice"
  | "public_decision"
  | "awardee_at_debrief"
  | "competitor_proposal"
  | "source_selection_information";

export interface Attestation {
  authorized: boolean;
  origin: DocumentOrigin;
  /** Why the user may lawfully hold this document (min 10 characters). */
  basis: string;
  attestedBy: string;
  attestedAt: string;
  protectiveOrder?: boolean;
  /** Case or order reference when the document is under a protective order. */
  protectiveOrderAuthority?: string;
  authorizedUnderOrder?: boolean;
}

export interface DocumentSubmission {
  kind: DocumentKind;
  filename: string;
  text: string;
  attestation: Attestation;
}

export interface SubmissionVerdict {
  allowed: boolean;
  reason: string;
  tags: string[];
  contentHash: string;
  sharesIntoCorpus: boolean;
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function bindAttestation(text: string, attestation: Attestation): Attestation & { contentHash: string } {
  return { ...attestation, contentHash: contentHash(text) };
}

export function validateAttestation(value: unknown): { ok: true; attestation: Attestation } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const input = value as Partial<Attestation> | null;
  if (!input || typeof input !== "object") return { ok: false, errors: ["attestation is required"] };
  if (input.authorized !== true) errors.push("authorized must be explicitly true");
  if (!input.basis || String(input.basis).trim().length < 10) errors.push("basis must explain, in at least 10 characters, why the document is lawfully held");
  if (!input.attestedBy || String(input.attestedBy).trim().length === 0) errors.push("attestedBy is required");
  const origin = input.origin;
  const origins: DocumentOrigin[] = [
    "offeror",
    "offeror_counsel",
    "agency_debrief",
    "agency_notice",
    "public_decision",
    "awardee_at_debrief",
    "competitor_proposal",
    "source_selection_information",
  ];
  if (!origin || !origins.includes(origin)) errors.push("origin must be a recognised document origin");
  if (input.protectiveOrder === true) {
    if (!input.protectiveOrderAuthority || String(input.protectiveOrderAuthority).trim().length === 0) {
      errors.push("a protective-order document needs its order or case reference");
    }
    if (input.authorizedUnderOrder !== true) errors.push("protective-order material is blocked until authorizedUnderOrder is confirmed");
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    attestation: {
      authorized: true,
      origin: origin as DocumentOrigin,
      basis: String(input.basis).trim(),
      attestedBy: String(input.attestedBy).trim(),
      attestedAt: input.attestedAt && !Number.isNaN(Date.parse(input.attestedAt)) ? new Date(input.attestedAt).toISOString() : new Date().toISOString(),
      protectiveOrder: input.protectiveOrder === true,
      protectiveOrderAuthority: input.protectiveOrderAuthority ? String(input.protectiveOrderAuthority).trim() : undefined,
      authorizedUnderOrder: input.authorizedUnderOrder === true,
    },
  };
}

const DENIED_ORIGINS: Partial<Record<DocumentOrigin, string>> = {
  competitor_proposal: "A competitor's proposal may not be processed: the Procurement Integrity Act forbids holding or using it.",
  source_selection_information: "Source selection information may not be processed: handling it is prohibited by the Procurement Integrity Act.",
};

/**
 * Decide whether a document may be stored and analysed at all. Deny is the
 * default; the caller stores only on `allowed`.
 */
export function reviewSubmission(submission: DocumentSubmission): SubmissionVerdict {
  const hash = contentHash(submission.text ?? "");
  const verdict = validateAttestation(submission.attestation);
  if (!verdict.ok) {
    return { allowed: false, reason: verdict.errors.join("; "), tags: [], contentHash: hash, sharesIntoCorpus: false };
  }
  const attestation = verdict.attestation;
  const denied = DENIED_ORIGINS[attestation.origin];
  if (denied) return { allowed: false, reason: denied, tags: [attestation.origin], contentHash: hash, sharesIntoCorpus: false };

  if (submission.kind === "awardee_excerpt" && attestation.origin !== "awardee_at_debrief") {
    return {
      allowed: false,
      reason: "Awardee excerpts are accepted only when they were provided to this offeror at its own debriefing.",
      tags: [attestation.origin],
      contentHash: hash,
      sharesIntoCorpus: false,
    };
  }
  if (attestation.origin === "public_decision" && submission.kind !== "protests" && submission.kind !== "other") {
    return {
      allowed: false,
      reason: "A public decision is corpus material, not an offeror document; import it through the protest corpus instead.",
      tags: [attestation.origin],
      contentHash: hash,
      sharesIntoCorpus: false,
    };
  }

  const tags: string[] = [attestation.origin, submission.kind];
  if (attestation.protectiveOrder) tags.push("protective_order");
  return {
    allowed: true,
    reason: "Attestation accepted.",
    tags,
    contentHash: hash,
    // Protective-order material is tenant-locked: it never reaches the shared
    // corpus, even in de-identified form.
    sharesIntoCorpus: attestation.origin === "public_decision" && !attestation.protectiveOrder,
  };
}

/** Anything written back into the shared corpus must be public and non-sealed. */
export function mayShareIntoCorpus(attestation: Attestation): boolean {
  return attestation.origin === "public_decision" && attestation.protectiveOrder !== true;
}
