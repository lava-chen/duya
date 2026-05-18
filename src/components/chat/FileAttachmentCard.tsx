import { XIcon } from '../icons';

interface FileAttachmentCardProps {
  id: string;
  name: string;
  size: number;
  thumbnail?: string;
  onRemove?: (id: string) => void;
  width?: number;
}

export function FileAttachmentCard({
  id,
  name,
  size,
  thumbnail,
  onRemove,
  width = 120,
}: FileAttachmentCardProps) {
  const ext = name.split('.').pop()?.toUpperCase() || 'FILE';
  const isPdf = ext === 'PDF';
  const hasThumbnail = !!thumbnail;

  const sizeText = size > 0 ? `${(size / 1024).toFixed(1)} KB` : 'Document';

  return (
    <div
      className="relative flex flex-col items-center rounded-lg border border-border/50 bg-muted/30 overflow-hidden"
      style={{ width }}
    >
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(id)}
          className="absolute top-1 right-1 z-10 w-5 h-5 rounded-full bg-black/40 flex items-center justify-center hover:bg-black/60 transition-colors"
        >
          <XIcon size={10} className="text-white" />
        </button>
      )}

      {/* Thumbnail / Preview Area */}
      <div
        className="flex-shrink-0 w-full flex items-center justify-center overflow-hidden relative"
        style={{ height: width * 0.85 }}
      >
        {hasThumbnail ? (
          <>
            <img
              src={thumbnail}
              alt={name}
              className="w-full h-full object-cover"
              loading="lazy"
            />
            {/* PDF badge overlay */}
            {isPdf && (
              <div className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-black/60 text-white/90 backdrop-blur-sm">
                PDF
              </div>
            )}
          </>
        ) : (
          <div
            className="w-full h-full flex items-center justify-center"
            style={{
              backgroundColor: isPdf
                ? 'rgba(239, 68, 68, 0.08)'
                : 'rgba(0, 0, 0, 0.04)',
            }}
          >
            <span
              className="text-[11px] font-bold"
              style={{ color: isPdf ? '#ef4444' : 'var(--muted)' }}
            >
              {ext}
            </span>
          </div>
        )}
      </div>

      {/* File info */}
      <div className="w-full px-2.5 py-2 min-w-0">
        <p
          className="text-[11px] font-medium truncate"
          style={{ color: 'var(--text)' }}
        >
          {name}
        </p>
        <p className="text-[10px] text-muted-foreground truncate">
          {sizeText}
        </p>
      </div>
    </div>
  );
}
