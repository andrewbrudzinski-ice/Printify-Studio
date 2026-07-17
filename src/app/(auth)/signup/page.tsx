import AuthClient from '../AuthClient';

export const metadata = { title: 'Create account — Printify Studio' };

export default function SignupPage() {
  return <AuthClient mode="signup" />;
}
