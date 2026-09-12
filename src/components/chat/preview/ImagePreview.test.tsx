/**
 * @vitest-environment jsdom
 */

import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { ImagePreview } from './ImagePreview';

describe('ImagePreview', () => {
  describe('open prop', () => {
    it('renders nothing when open={false}', () => {
      const { container } = render(
        <ImagePreview
          open={false}
          onClose={vi.fn()}
          variant="lightbox"
          src="https://example.com/a.png"
          alt="x"
        />,
      );
      expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when open={false} for the panel variant', () => {
      const { container } = render(
        <ImagePreview
          open={false}
          onClose={vi.fn()}
          variant="panel"
          title="Preview"
          body={<div>some body</div>}
        />,
      );
      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('lightbox variant', () => {
    it('renders overlay + close button + <img> with the right src', () => {
      render(
        <ImagePreview
          open
          onClose={vi.fn()}
          variant="lightbox"
          src="https://example.com/pic.png"
          alt="diagram"
        />,
      );
      expect(screen.getByRole('dialog')).toHaveClass('image-preview-overlay');
      expect(screen.getByRole('button', { name: /close preview/i })).toHaveClass(
        'image-preview-close',
      );
      expect(screen.getByRole('img', { name: 'diagram' })).toHaveAttribute(
        'src',
        'https://example.com/pic.png',
      );
    });

    it('renders a caption under the image when alt is set and not equal to "page.png"', () => {
      render(
        <ImagePreview
          open
          onClose={vi.fn()}
          variant="lightbox"
          src="https://example.com/pic.png"
          alt="a real caption"
        />,
      );
      const caption = screen.getByText('a real caption');
      expect(caption).toHaveClass('image-preview-caption');
    });

    it('does not render a caption when alt is exactly "page.png"', () => {
      render(
        <ImagePreview
          open
          onClose={vi.fn()}
          variant="lightbox"
          src="https://example.com/page.png"
          alt="page.png"
        />,
      );
      expect(screen.queryByText('page.png')).not.toBeInTheDocument();
    });

    it('does not render a caption when alt is empty', () => {
      const { container } = render(
        <ImagePreview
          open
          onClose={vi.fn()}
          variant="lightbox"
          src="https://example.com/pic.png"
          alt=""
        />,
      );
      expect(container.querySelector('.image-preview-caption')).toBeNull();
    });
  });

  describe('panel variant', () => {
    it('renders overlay + close button + panel header (title, subtitle) + body (img + text)', () => {
      render(
        <ImagePreview
          open
          onClose={vi.fn()}
          variant="panel"
          src="https://example.com/pic.png"
          alt="diagram"
          title="Screenshot.png"
          subtitle="1280×720 · 12 KB"
          body={<p>analysis text</p>}
        />,
      );
      expect(screen.getByRole('dialog')).toHaveClass('image-preview-overlay');
      expect(screen.getByRole('button', { name: /close preview/i })).toHaveClass(
        'image-preview-close',
      );
      expect(screen.getByRole('heading', { name: 'Screenshot.png' })).toHaveClass(
        'image-preview-panel-title',
      );
      expect(screen.getByText('1280×720 · 12 KB')).toHaveClass(
        'image-preview-panel-subtitle',
      );
      expect(screen.getByRole('img', { name: 'diagram' })).toBeInTheDocument();
      expect(screen.getByText('analysis text')).toBeInTheDocument();
    });

    it('omits the header block when both title and subtitle are absent', () => {
      const { container } = render(
        <ImagePreview
          open
          onClose={vi.fn()}
          variant="panel"
          src="https://example.com/pic.png"
          alt="diagram"
          body={<p>just body</p>}
        />,
      );
      expect(container.querySelector('.image-preview-panel-header')).toBeNull();
    });

    it('hides the image slot when bodyOnly={true}', () => {
      const { container } = render(
        <ImagePreview
          open
          onClose={vi.fn()}
          variant="panel"
          src="https://example.com/pic.png"
          alt="diagram"
          body={<pre>code body</pre>}
          bodyOnly
        />,
      );
      expect(screen.getByText('code body')).toBeInTheDocument();
      expect(container.querySelector('.image-preview-panel-image')).toBeNull();
    });
  });

  describe('Escape key', () => {
    it('closes the lightbox when Escape is pressed', () => {
      const onClose = vi.fn();
      render(
        <ImagePreview
          open
          onClose={onClose}
          variant="lightbox"
          src="https://example.com/pic.png"
          alt="x"
        />,
      );
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes the panel when Escape is pressed', () => {
      const onClose = vi.fn();
      render(
        <ImagePreview
          open
          onClose={onClose}
          variant="panel"
          src="https://example.com/pic.png"
          alt="x"
          title="T"
        />,
      );
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('ignores other keys', () => {
      const onClose = vi.fn();
      render(
        <ImagePreview
          open
          onClose={onClose}
          variant="lightbox"
          src="https://example.com/pic.png"
          alt="x"
        />,
      );
      fireEvent.keyDown(document, { key: 'Enter' });
      fireEvent.keyDown(document, { key: 'a' });
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('click-outside', () => {
    it('closes the lightbox when the overlay is clicked', () => {
      const onClose = vi.fn();
      render(
        <ImagePreview
          open
          onClose={onClose}
          variant="lightbox"
          src="https://example.com/pic.png"
          alt="x"
        />,
      );
      fireEvent.click(screen.getByRole('dialog'));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not close when the inner canvas is clicked', () => {
      const onClose = vi.fn();
      const { container } = render(
        <ImagePreview
          open
          onClose={onClose}
          variant="lightbox"
          src="https://example.com/pic.png"
          alt="x"
        />,
      );
      const canvas = container.querySelector('.image-preview-canvas');
      expect(canvas).not.toBeNull();
      fireEvent.click(canvas as HTMLElement);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('does not close when the inner panel is clicked', () => {
      const onClose = vi.fn();
      const { container } = render(
        <ImagePreview
          open
          onClose={onClose}
          variant="panel"
          src="https://example.com/pic.png"
          alt="x"
          title="T"
        />,
      );
      const panel = container.querySelector('.image-preview-panel');
      expect(panel).not.toBeNull();
      fireEvent.click(panel as HTMLElement);
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('close button', () => {
    it('closes when the close button is clicked', () => {
      const onClose = vi.fn();
      render(
        <ImagePreview
          open
          onClose={onClose}
          variant="lightbox"
          src="https://example.com/pic.png"
          alt="x"
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /close preview/i }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});