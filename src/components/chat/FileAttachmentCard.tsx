import { XIcon } from '../icons';

interface FileAttachmentCardProps {
  id: string;
  name: string;
  thumbnail?: string;
  onRemove?: (id: string) => void;
  width?: number;
}

export function FileAttachmentCard({
  id,
  name,
  thumbnail,
  onRemove,
  width = 120,
}: FileAttachmentCardProps) {
  const ext = name.split('.').pop()?.toUpperCase() || 'FILE';
  const isPdf = ext === 'PDF';
  const hasThumbnail = !!thumbnail;

  // For non-PDF files with thumbnail: show horizontal layout with name + ext badge + preview
  const isHorizontalLayout = !isPdf && hasThumbnail;

  if (isHorizontalLayout) {
    return (
      <div
        className="relative flex items-stretch rounded-lg border border-border/50 bg-muted/30 overflow-hidden"
        style={{ width: width * 2.2 }}
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

        {/* Left side: File name and ext badge */}
        <div className="flex-1 flex flex-col justify-between p-3 min-w-0">
          <p
            className="text-[13px] font-medium leading-tight line-clamp-2"
            style={{ color: 'var(--text)' }}
          >
            {name}
          </p>
          <div className="px-2 py-1 rounded-md text-[10px] font-medium bg-white/90 text-gray-700 shadow-sm border border-gray-200 w-fit">
            {ext}
          </div>
        </div>

        {/* Right side: Thumbnail */}
        <div
          className="flex-shrink-0 overflow-hidden"
          style={{ width: width, height: width }}
        >
          <img
            src={thumbnail}
            alt={name}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        </div>
      </div>
    );
  }

  // PDF or files without thumbnail: vertical layout with square preview
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
        style={{ height: width }}
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
              <div className="absolute bottom-2 left-2 px-2 py-1 rounded-md text-[10px] font-medium bg-white/90 text-gray-700 shadow-sm border border-gray-200">
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
    </div>
  );
}
