'use client';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{error.message}</p>
      <button
        onClick={reset}
        className="mt-4 rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white"
      >
        Try again
      </button>
    </div>
  );
}
