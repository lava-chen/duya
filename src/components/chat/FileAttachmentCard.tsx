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
  const isImage = ['PNG', 'JPG', 'JPEG', 'GIF', 'WEBP', 'BMP', 'SVG'].includes(ext);
  const isDoc = ['DOC', 'DOCX'].includes(ext);
  const hasThumbnail = !!thumbnail;

  // For image files with thumbnail: show square image preview
  // For doc files: show horizontal layout with name + ext badge (like reference image)
  // For PDFs with thumbnail: show vertical layout with thumbnail + PDF badge
  // For other files without thumbnail: show vertical layout with ext label

  // Image files: square preview with image filling the card
  if (isImage && hasThumbnail) {
    return (
      <div
        className="relative rounded-2xl border border-border/50 overflow-hidden flex-shrink-0"
        style={{ width, height: width }}
      >
        {onRemove && (
          <button
            type="button"
            onClick={() => onRemove(id)}
            className="absolute top-1.5 right-1.5 z-10 w-5 h-5 rounded-full bg-black/50 flex items-center justify-center hover:bg-black/70 transition-colors"
          >
            <XIcon size={10} className="text-white" />
          </button>
        )}
        <img
          src={thumbnail}
          alt={name}
          className="w-full h-full object-cover"
          loading="lazy"
        />
      </div>
    );
  }

  // Document files (DOCX, etc.): horizontal layout with name + ext badge
  if (isDoc) {
    return (
      <div
        className="relative flex items-stretch rounded-2xl border border-border/50 bg-muted/30 overflow-hidden"
        style={{ width: width * 2.2, height: width }}
      >
        {onRemove && (
          <button
            type="button"
            onClick={() => onRemove(id)}
            className="absolute -top-1.5 -right-1.5 z-10 w-5 h-5 rounded-full bg-black/50 flex items-center justify-center hover:bg-black/70 transition-colors"
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

        {/* Right side: Thumbnail (if available) */}
        {hasThumbnail && (
          <div
            className="flex-shrink-0 overflow-hidden border-l border-border/30"
            style={{ width: width * 0.75, height: width }}
          >
            <img
              src={thumbnail}
              alt={name}
              className="w-full h-full object-contain"
              loading="lazy"
            />
          </div>
        )}
      </div>
    );
  }

  // PDF or files with thumbnail: vertical layout with square preview
  if (hasThumbnail) {
    return (
      <div
        className="relative flex flex-col items-center rounded-2xl border border-border/50 bg-muted/30 overflow-hidden flex-shrink-0"
        style={{ width }}
      >
        {onRemove && (
          <button
            type="button"
            onClick={() => onRemove(id)}
            className="absolute top-1.5 right-1.5 z-10 w-5 h-5 rounded-full bg-black/50 flex items-center justify-center hover:bg-black/70 transition-colors"
          >
            <XIcon size={10} className="text-white" />
          </button>
        )}

        {/* Thumbnail Preview Area */}
        <div
          className="flex-shrink-0 w-full overflow-hidden relative"
          style={{ height: width }}
        >
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
        </div>
      </div>
    );
  }

  // Files without thumbnail: vertical layout with ext label only
  return (
    <div
      className="relative flex flex-col items-center rounded-2xl border border-border/50 bg-muted/30 overflow-hidden flex-shrink-0"
      style={{ width }}
    >
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(id)}
          className="absolute top-1.5 right-1.5 z-10 w-5 h-5 rounded-full bg-black/50 flex items-center justify-center hover:bg-black/70 transition-colors"
        >
          <XIcon size={10} className="text-white" />
        </button>
      )}

      {/* Ext Label Area */}
      <div
        className="w-full flex items-center justify-center"
        style={{
          height: width,
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
    </div>
  );
}
