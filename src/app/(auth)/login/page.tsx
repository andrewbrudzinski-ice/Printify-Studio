import AuthClient from '../AuthClient';

export const metadata = { title: 'Sign in — Printify Studio' };

export default function LoginPage() {
  return <AuthClient mode="login" />;
}
