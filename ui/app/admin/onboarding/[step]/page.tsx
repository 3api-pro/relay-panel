import OnboardingClient from './OnboardingClient';

export function generateStaticParams() {
  return [{ step: '1' }, { step: '2' }, { step: '3' }, { step: '4' }, { step: '5' }];
}

export default function OnboardingStepPage({ params }: { params: { step: string } }) {
  return <OnboardingClient step={params.step} />;
}
