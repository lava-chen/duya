import {
  Code,
  FileArchiveIcon,
  FileCIcon,
  FileCode,
  FileCppIcon,
  FileCssIcon,
  FileDocIcon,
  FileHtmlIcon,
  FileImageIcon,
  FileIniIcon,
  FileJsIcon,
  FileJsxIcon,
  FileJpgIcon,
  FileMdIcon,
  FilePdfIcon,
  FilePngIcon,
  FilePyIcon,
  FileRsIcon,
  FileSqlIcon,
  FileSvgIcon,
  FileTextIcon,
  FileTsIcon,
  FileVueIcon,
} from '@phosphor-icons/react';

/** Returns the same extension-specific icon used by the project file tree. */
export function getFileTypeIcon(extension?: string) {
  switch (extension?.toLowerCase()) {
    case 'ts':
    case 'tsx':
      return FileTsIcon;
    case 'js':
      return FileJsIcon;
    case 'jsx':
      return FileJsxIcon;
    case 'py':
    case 'pyc':
    case 'pyo':
    case 'pyd':
      return FilePyIcon;
    case 'rs':
      return FileRsIcon;
    case 'c':
      return FileCIcon;
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'h':
    case 'hpp':
      return FileCppIcon;
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return FileCssIcon;
    case 'html':
    case 'htm':
      return FileHtmlIcon;
    case 'vue':
      return FileVueIcon;
    case 'png':
      return FilePngIcon;
    case 'jpg':
    case 'jpeg':
      return FileJpgIcon;
    case 'gif':
    case 'bmp':
    case 'webp':
    case 'ico':
      return FileImageIcon;
    case 'svg':
      return FileSvgIcon;
    case 'pdf':
      return FilePdfIcon;
    case 'doc':
    case 'docx':
      return FileDocIcon;
    case 'md':
    case 'mdx':
      return FileMdIcon;
    case 'sql':
      return FileSqlIcon;
    case 'json':
    case 'yaml':
    case 'yml':
    case 'toml':
      return Code;
    case 'ini':
    case 'cfg':
    case 'conf':
      return FileIniIcon;
    case 'zip':
    case 'rar':
    case '7z':
    case 'tar':
    case 'gz':
    case 'bz2':
      return FileArchiveIcon;
    case 'txt':
    case 'log':
      return FileTextIcon;
    case 'rb':
    case 'go':
    case 'java':
    case 'swift':
    case 'kt':
    case 'dart':
    case 'lua':
    case 'php':
    case 'zig':
    case 'r':
    case 'pl':
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
      return FileCode;
    default:
      return undefined;
  }
}

export function fileExtensionFromName(fileName: string): string | undefined {
  const withoutLineSuffix = fileName.replace(/:\d+$/, '');
  const extensionIndex = withoutLineSuffix.lastIndexOf('.');
  return extensionIndex > 0 ? withoutLineSuffix.slice(extensionIndex + 1) : undefined;
}
