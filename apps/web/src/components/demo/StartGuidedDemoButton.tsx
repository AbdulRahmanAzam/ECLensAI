import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useGuidedDemo } from '@/providers/GuidedDemoProvider';

/** Visible on every authenticated page — the tour is restartable, never one-shot. */
export function StartGuidedDemoButton() {
  const { start } = useGuidedDemo();
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={<Sparkles className="h-3.5 w-3.5" />}
      onClick={start}
    >
      Guided Demo
    </Button>
  );
}
