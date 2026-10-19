export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <div className="flex items-center justify-center gap-3 py-8 text-neutral-400">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-700 border-t-accent" />
      {label ? <span className="text-sm">{label}</span> : null}
    </div>
  );
}
