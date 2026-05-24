import { XIcon } from '../icons';

interface FileAttachmentCardProps {
  id: string;
  name: string;
  thumbnail?: string;
  onRemove?: (id: string) => void;
  onClick?: () => void;
  width?: number;
}

export function FileAttachmentCard({
  id,
  name,
  thumbnail,
  onRemove,
  onClick,
  width = 120,
}: FileAttachmentCardProps) {
  const ext = name.split('.').pop()?.toUpperCase() || 'FILE';
  const isPdf = ext === 'PDF';
  const isImage = ['PNG', 'JPG', 'JPEG', 'GIF', 'WEBP', 'BMP', 'SVG'].includes(ext);
  const hasThumbnail = !!thumbnail;
  const isClickable = !!onClick;

  const cardBorderStyle = {
    border: '1px solid var(--border)',
  };

  // Image files: square preview with image filling the card
  if (isImage && hasThumbnail) {
    return (
      <div
        className={`group relative rounded-2xl overflow-hidden flex-shrink-0 ${isClickable ? 'cursor-pointer hover:border-accent/50 hover:shadow-sm transition-all' : ''}`}
        style={{ width, height: width, ...cardBorderStyle }}
        onClick={onClick}
        role={isClickable ? 'button' : undefined}
        tabIndex={isClickable ? 0 : undefined}
        onKeyDown={isClickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}
      >
        {onRemove && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove(id); }}
            className="absolute top-1.5 right-1.5 z-10 w-4 h-4 rounded-full bg-black/50 flex items-center justify-center hover:bg-black/70 transition-colors opacity-0 group-hover:opacity-100"
          >
            <XIcon size={8} className="text-white" />
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

  // PDF with thumbnail: square preview with thumbnail as background + PDF badge
  if (isPdf && hasThumbnail) {
    return (
      <div
        className={`group relative rounded-2xl overflow-hidden flex-shrink-0 ${isClickable ? 'cursor-pointer hover:border-accent/50 hover:shadow-sm transition-all' : ''}`}
        style={{ width, height: width, ...cardBorderStyle }}
        onClick={onClick}
        role={isClickable ? 'button' : undefined}
        tabIndex={isClickable ? 0 : undefined}
        onKeyDown={isClickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}
      >
        {onRemove && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove(id); }}
            className="absolute top-1.5 right-1.5 z-10 w-4 h-4 rounded-full bg-black/50 flex items-center justify-center hover:bg-black/70 transition-colors opacity-0 group-hover:opacity-100"
          >
            <XIcon size={8} className="text-white" />
          </button>
        )}
        <img
          src={thumbnail}
          alt={name}
          className="w-full h-full object-cover"
          loading="lazy"
        />
        {/* PDF badge overlay */}
        <div
          className="absolute bottom-2 left-2 px-2 py-1 rounded-md text-[10px] font-medium w-fit"
          style={{
            backgroundColor: 'var(--bg-canvas)',
            color: 'var(--muted)',
            border: '1px solid var(--border)',
          }}
        >
          PDF
        </div>
      </div>
    );
  }

  // All other files (DOC, DOCX, YML, EXE, etc.): square layout with name + ext badge
  return (
    <div
      className={`group relative flex flex-col justify-between rounded-2xl overflow-hidden flex-shrink-0 ${isClickable ? 'cursor-pointer hover:border-accent/50 hover:shadow-sm transition-all' : ''}`}
      style={{ width, height: width, backgroundColor: 'var(--bg-canvas)', ...cardBorderStyle }}
      onClick={onClick}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onKeyDown={isClickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}
    >
      {onRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(id); }}
          className="absolute top-1.5 right-1.5 z-10 w-4 h-4 rounded-full bg-[var(--muted)]/70 flex items-center justify-center hover:bg-[var(--muted)] transition-colors opacity-0 group-hover:opacity-100"
        >
          <XIcon size={8} className="text-white" />
        </button>
      )}

      {/* File name */}
      <p
        className="text-[13px] font-medium leading-tight line-clamp-3 p-3 pb-0"
        style={{ color: 'var(--text)' }}
      >
        {name}
      </p>

      {/* Ext badge */}
      <div className="p-3 pt-0">
        <div
          className="px-2 py-1 rounded-md text-[10px] font-medium w-fit"
          style={{
            backgroundColor: 'var(--bg-canvas)',
            color: 'var(--muted)',
            border: '1px solid var(--border)',
          }}
        >
          {ext}
        </div>
      </div>
    </div>
  );
}
