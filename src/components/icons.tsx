"use client";

import {
  ArrowUpRightIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  LightningIcon,
  MagicWandIcon,
  SparkleIcon,
  ClockCounterClockwiseIcon,
  PlayCircleIcon,
  RepeatIcon,
  GearSixIcon,
  KeyIcon,
  MonitorIcon,
  PlugIcon,
  ShieldCheckIcon,
  CodeIcon,
  DatabaseIcon,
  GlobeHemisphereWestIcon,
  GlobeIcon,
  DotsThreeIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  PencilIcon,
  SquaresFourIcon,
  CornersInIcon,
  CornersOutIcon,
  SunIcon,
  MoonIcon,
  MoonStarsIcon,
  PaperPlaneRightIcon,
  PaperPlaneTiltIcon,
  StopIcon,
  UserIcon,
  HouseIcon,
  CpuIcon,
  CubeIcon,
  SpinnerGapIcon,
  InfoIcon,
  ShieldIcon,
  XIcon,
  CommandIcon,
  PlusIcon,
  MinusIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  MicrophoneIcon,
  ArrowUpIcon,
  TerminalIcon,
  QuestionIcon,
  EraserIcon,
  ChartLineIcon,
  ChartBarIcon,
  GlobeSimpleIcon,
  CopyIcon,
  CheckIcon,
  CaretUpIcon,
  ChatCircleIcon,
  FileIcon,
  WrenchIcon,
  CheckCircleIcon,
  XCircleIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  ArchiveIcon,
  EyeIcon,
  EyeSlashIcon,
  CircleIcon,
  CircleNotchIcon,
  TrashIcon,
  FileTextIcon,
  FilePdfIcon,
  FileXlsIcon,
  FilePptIcon,
  FileCsvIcon,
  FileDocIcon,
  FileImageIcon,
  FileCodeIcon,
  FileAudioIcon,
  FileVideoIcon,
  FileZipIcon,
  UploadSimpleIcon,
  WarningIcon,
  ProhibitIcon,
  HardDrivesIcon,
  PowerIcon,
  ChatCircleTextIcon,
  LightbulbIcon,
  ImageIcon,
  CursorClickIcon,
  CookieIcon,
  At as AtSignIcon,
  MagnifyingGlassIcon as SearchIcon,
  CaretDownIcon as ChevronDownIcon,
  CaretUpIcon as ChevronUpIcon,
  StarIcon,
  // Bridge icons
  WifiHighIcon,
  TelegramLogoIcon,
  ArrowsClockwiseIcon,
  // Browser extension icons
  GoogleChromeLogoIcon,
  ArrowSquareOutIcon,
  // Attachment menu icons
  PaperclipIcon,
  GithubLogoIcon,
  FeatherIcon,
  DownloadSimpleIcon,
  ArrowCounterClockwiseIcon,
  TestTubeIcon,
  UsersThreeIcon,
  BookOpenIcon,
  ListChecksIcon,
} from "@phosphor-icons/react";

// Tabler Icons - Agent icons & Channel icons
import {
  IconCardboards,
  IconBrain,
  IconCode,
  IconMessageCircle,
  IconRobot,
  IconLayoutSidebarRight,
} from "@tabler/icons-react";

// Re-export all icons
export {
  ArrowUpRightIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  LightningIcon,
  MagicWandIcon,
  SparkleIcon,
  ClockCounterClockwiseIcon,
  PlayCircleIcon,
  RepeatIcon,
  GearSixIcon,
  KeyIcon,
  MonitorIcon,
  PlugIcon,
  ShieldCheckIcon,
  CodeIcon,
  DatabaseIcon,
  GlobeHemisphereWestIcon,
  GlobeIcon,
  DotsThreeIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  PencilIcon,
  SquaresFourIcon,
  CornersInIcon,
  CornersOutIcon,
  SunIcon,
  MoonIcon,
  MoonStarsIcon,
  PaperPlaneRightIcon,
  PaperPlaneTiltIcon,
  StopIcon,
  UserIcon,
  HouseIcon,
  CpuIcon,
  CubeIcon,
  SpinnerGapIcon,
  InfoIcon,
  ShieldIcon,
  XIcon,
  CommandIcon,
  PlusIcon,
  MinusIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  MicrophoneIcon,
  ArrowUpIcon,
  TerminalIcon,
  QuestionIcon,
  EraserIcon,
  ChartLineIcon,
  ChartBarIcon,
  GlobeSimpleIcon,
  CopyIcon,
  CheckIcon,
  CaretUpIcon,
  ChatCircleIcon,
  FileIcon,
  WrenchIcon,
  CheckCircleIcon,
  XCircleIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  ArchiveIcon,
  EyeIcon,
  EyeSlashIcon,
  CircleIcon,
  CircleNotchIcon,
  TrashIcon,
  FileTextIcon,
  FilePdfIcon,
  FileXlsIcon,
  FilePptIcon,
  FileCsvIcon,
  FileDocIcon,
  FileImageIcon,
  FileCodeIcon,
  FileAudioIcon,
  FileVideoIcon,
  FileZipIcon,
  UploadSimpleIcon,
  WarningIcon,
  ProhibitIcon,
  HardDrivesIcon,
  PowerIcon,
  ChatCircleTextIcon,
  LightbulbIcon,
  ImageIcon,
  CursorClickIcon,
  CookieIcon,
  AtSignIcon,
  SearchIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  StarIcon,
  // Bridge icons
  WifiHighIcon,
  TelegramLogoIcon,
  ArrowsClockwiseIcon,
  // Browser extension icons
  GoogleChromeLogoIcon as ChromeIcon,
  ArrowSquareOutIcon as ExternalLinkIcon,
  // Attachment menu icons
  PaperclipIcon,
  GithubLogoIcon,
  FeatherIcon,
  DownloadSimpleIcon,
  // Tabler Icons - Agent icons (using IconCardboards as main agent icon)
  IconCardboards as RobotIcon,
  IconBrain as BrainIcon,
  IconCode as TablerCodeIcon,
  IconMessageCircle as TablerMessageCircleIcon,
  IconRobot as TablerRobotIcon,
  // Tabler Icons - Channel icons
  IconMessageCircle as ChannelIcon,
  // Reset icon
  ArrowCounterClockwiseIcon,
  // Plan 204 — provider actions icons
  TestTubeIcon,
  UsersThreeIcon,
  BookOpenIcon,
  ListChecksIcon,
};

// Aliases for backward compatibility
export const ServerIcon = HardDrivesIcon;
export const MessageCircleIcon = ChatCircleTextIcon;
export const ZapIcon = LightningIcon;
export const PowerOffIcon = PowerIcon;

// SpinnerIcon is an alias for CircleNotchIcon
export const SpinnerIcon = CircleNotchIcon;

// DocumentTextIcon is an alias for FileTextIcon
export const DocumentTextIcon = FileTextIcon;

// ClockIcon is an alias for ClockCounterClockwiseIcon
export const ClockIcon = ClockCounterClockwiseIcon;

// SidebarRightIcon is an alias for IconLayoutSidebarRight (tabler)
export const SidebarRightIcon = IconLayoutSidebarRight;

// TelescopeIcon is not shipped in @phosphor-icons/core, so we ship a small
// inline SVG instead. Shape: a tilted telescope tube on a tripod stand.
// Matches the IconProps contract used by every other icon in this file so
// `size`, `color`, and standard SVG attributes pass through unchanged.
import { forwardRef, type ComponentPropsWithoutRef, type RefAttributes } from 'react';
type TelescopeIconProps = ComponentPropsWithoutRef<'svg'> & RefAttributes<SVGSVGElement> & {
  size?: string | number;
  color?: string;
};
export const TelescopeIcon = forwardRef<SVGSVGElement, TelescopeIconProps>(
  ({ size = 16, color = 'currentColor', ...rest }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      stroke={color}
      strokeWidth={16}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {/* Tube — diagonal cylinder from upper-left to lower-right */}
      <line x1="120" y1="116" x2="56" y2="52" />
      <line x1="160" y1="156" x2="96" y2="92" />
      <line x1="120" y1="116" x2="160" y2="156" />
      <line x1="56" y1="52" x2="96" y2="92" />
      {/* Eyepiece */}
      <line x1="160" y1="156" x2="184" y2="180" />
      <line x1="120" y1="116" x2="144" y2="140" />
      {/* Tripod legs converging at the eyepiece base */}
      <line x1="152" y1="168" x2="104" y2="216" />
      <line x1="152" y1="168" x2="200" y2="216" />
      <line x1="152" y1="168" x2="152" y2="216" />
      {/* Ground line under the tripod feet */}
      <line x1="80" y1="216" x2="224" y2="216" />
    </svg>
  ),
);
TelescopeIcon.displayName = 'TelescopeIcon';
