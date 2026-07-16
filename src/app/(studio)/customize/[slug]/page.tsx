import CustomizeClient from './CustomizeClient';

export const metadata = { title: 'Customise — Printify Studio' };

export default async function CustomizePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <CustomizeClient slug={slug} />;
}
