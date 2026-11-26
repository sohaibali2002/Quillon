// Quillon brand marks: the crossguard glyph is the wordmark's anchor.

export function BrandMark({ className = "brand-mark" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v5.5" />
      <path d="M4.5 8.5h15" />
      <path d="M9 12.5c0 4 1.4 6.5 3 8.5 1.6-2 3-4.5 3-8.5" />
      <circle cx="12" cy="8.5" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function Brand({ small = "Enterprise AI" }: { small?: string }) {
  return (
    <span className="brand">
      <BrandMark />
      quillon
      <small>{small}</small>
    </span>
  );
}
