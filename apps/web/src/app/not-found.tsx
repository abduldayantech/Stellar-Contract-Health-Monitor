import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
        <Link href="/" className="text-indigo-600 hover:underline">
          Back to overview
        </Link>
      </p>
    </div>
  );
}
