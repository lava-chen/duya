/**
 * src/components/providers/ProviderAddButton.tsx
 *
 * Plan 205: a single right-aligned "Add provider" button that
 * navigates to the `provider-picker` sub-view via the settings
 * tab store. Replaces the previous `<details>`-based dropdown
 * (Plan 204) so the user lands on a proper inline page with the
 * full list of presets, rather than a popup menu.
 */

import { PlusIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { useConversationStore } from '@/stores/conversation-store';
import { useTranslation } from '@/hooks/useTranslation';

export interface ProviderAddButtonProps {
  /** Reserved for future — when caller wants to override the
   *  default tab. Today the button always navigates to
   *  `provider-picker`. */
  onAdd?: () => void;
}

export function ProviderAddButton({ onAdd }: ProviderAddButtonProps) {
  const { t } = useTranslation();
  const setSettingsTab = useConversationStore((s) => s.setSettingsTab);

  const handleClick = () => {
    if (onAdd) onAdd();
    setSettingsTab('provider-picker');
  };

  return (
    <Button
      variant="primary"
      size="sm"
      onClick={handleClick}
      data-testid="provider-add-button"
    >
      <PlusIcon size={14} />
      {t('provider.addProvider')}
    </Button>
  );
}
