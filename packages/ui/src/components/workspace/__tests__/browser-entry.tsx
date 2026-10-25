import React from 'react';
import { createRoot } from 'react-dom/client';
import { CheckoutControls } from '../CheckoutControls';
import { I18nContext } from '../../layout/I18nProvider';
import { translate } from '../../../i18n';
import type { SessionCheckoutCommand } from '@duya/agent-protocol';
import '../../../styles/workspace-lifecycle.css';

const fixture = await fetch('/fixture').then((response) => response.json());
const control = async (sessionId: string, command: SessionCheckoutCommand) => {
  const response = await fetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, command }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? body.error?.code ?? 'Checkout request failed');
  return body.result;
};
const onChange = async () => {};
createRoot(document.getElementById('root')!).render(
  <I18nContext.Provider value={{ locale: 'en', setLocale: () => {}, isLoading: false, t: (key, params) => translate('en', key, params) }}>
    <CheckoutControls sessionId={fixture.sessionId} control={control} onChange={onChange} />
  </I18nContext.Provider>,
);
