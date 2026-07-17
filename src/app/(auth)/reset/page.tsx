import AuthClient from '../AuthClient';

export const metadata = { title: 'Reset password — Printify Studio' };

export default function ResetPage() {
  return <AuthClient mode="reset" />;
}
