"use client";

import React, { useState } from 'react';
import { PencilIcon, TrashIcon, DotsThreeIcon, ArrowBendDownRightIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import type { MailboxRow } from '@/stores/mailbox-store';
import type { FileAttachment } from '@/types/message';
import { useTranslation } from '@/hooks/useTranslation';
import { mailboxAttachments } from '@/lib/chat-edit-draft';
import { AttachmentBar } from './AttachmentBar';
import { ImagePreview } from './preview/ImagePreview';

interface MailboxBubbleProps {
  row: MailboxRow;
  onCancel: (id: string) => void;
  onGuide?: (row: MailboxRow) => void | Promise<void>;
  onEditInComposer?: (row: MailboxRow) => void;
  onMore?: (row: MailboxRow) => void;
}

export function MailboxBubble({ row, onCancel, onGuide, onEditInComposer, onMore }: MailboxBubbleProps) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<FileAttachment | null>(null);
  const attachments = mailboxAttachments(row.attachmentsJson);
  const editable = row.status === 'pending' && !row.id.startsWith('optimistic-');
  const following = row.kind === 'followup';
  const status = row.id.startsWith('optimistic-') ? t('mailbox.bubble.saving')
    : row.status === 'observed' ? t('mailbox.bubble.pickedUp')
    : following ? t('mailbox.bubble.currentRun') : t('mailbox.bubble.nextTurn');
  return (
    <div className="mailbox-bubble mailbox-bubble--with-attachments">
      <div className="mailbox-bubble-main">
        <div className="mailbox-bubble-summary">
          <span className="mailbox-bubble-status" role="status">{status}</span>
          <p className="mailbox-bubble-content" title={row.content}>{row.content || t('mailbox.bubble.attachmentsOnly')}</p>
        </div>
        {attachments.length > 0 && <AttachmentBar attachments={attachments} mode="history" cardWidth={48} onPreview={setPreview} />}
      </div>
      <div className="mailbox-bubble-actions">
        {editable && !following && onGuide && <Button type="button" variant="ghost" size="sm"
          onClick={() => void onGuide(row)} className="mailbox-bubble-action mailbox-bubble-action--guide"
          title={t('mailbox.bubble.guideHint')} aria-label={t('mailbox.guide')}>
          <ArrowBendDownRightIcon size={13} /><span>{t('mailbox.guide')}</span>
        </Button>}
        {editable && onEditInComposer && <IconButton type="button" variant="ghost" shape="square" size="sm"
          onClick={() => onEditInComposer(row)} className="mailbox-bubble-action"
          title={t('mailbox.bubble.edit')} aria-label={t('mailbox.bubble.edit')}><PencilIcon size={13} /></IconButton>}
        {editable && <IconButton type="button" variant="danger" shape="square" size="sm"
          onClick={() => onCancel(row.id)} className="mailbox-bubble-action mailbox-bubble-action--danger"
          title={t('mailbox.bubble.delete')} aria-label={t('mailbox.bubble.delete')}><TrashIcon size={13} /></IconButton>}
        {onMore && <IconButton type="button" variant="ghost" shape="square" size="sm" onClick={() => onMore(row)}
          className="mailbox-bubble-action" title={t('mailbox.more')} aria-label={t('mailbox.more')}><DotsThreeIcon size={13} /></IconButton>}
      </div>
      <ImagePreview open={preview !== null} onClose={() => setPreview(null)} variant="panel" attachment={preview} />
    </div>
  );
}
