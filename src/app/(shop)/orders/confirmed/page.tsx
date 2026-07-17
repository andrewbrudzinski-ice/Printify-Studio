// The post-payment landing. Deliberately does no verification of its own:
// the Stripe webhook is the single authority on payment state, and this page
// arriving before the webhook has fired is normal. It promises email, not
// instant state.
import Link from 'next/link';

export const metadata = { title: 'Order confirmed — Printify Studio' };

export default function ConfirmedPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-3xl font-bold tracking-tight">Thank you — that&apos;s ordered.</h1>
      <p className="text-neutral-600">
        Your payment went through. We&apos;re generating your print files and handing them to the
        printer; a confirmation email is on its way to you.
      </p>
      <p className="text-sm text-neutral-500">
        <Link href="/upload" className="underline">
          Start another photo
        </Link>
      </p>
    </main>
  );
}
