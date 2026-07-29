"use client";

// All icons now sourced from @tabler/icons-react. Export names are preserved
// so business files keep importing `XxxIcon` from `@/components/icons` unchanged.
import {
  // Original phosphor-equivalent icons
  IconArrowUpRight,
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconBolt,
  IconWand,
  IconSparkles,
  IconHistory,
  IconPlayerPlay,
  IconRepeat,
  IconSettings,
  IconKey,
  IconDeviceDesktop,
  IconPlugConnected,
  IconShieldCheck,
  IconCode,
  IconDatabase,
  IconWorld,
  IconDots,
  IconSearch,
  IconEdit,
  IconPencil,
  IconLayoutGrid,
  IconMinimize,
  IconMaximize,
  IconSun,
  IconMoon,
  IconMoonStars,
  IconSend,
  IconPlayerStop,
  IconUser,
  IconHome,
  IconCpu,
  IconCube,
  IconLoader2,
  IconInfoCircle,
  IconShield,
  IconX,
  IconCommand,
  IconPlus,
  IconMinus,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconMicrophone,
  IconTerminal,
  IconHelpCircle,
  IconEraser,
  IconChartLine,
  IconChartBar,
  IconCopy,
  IconCheck,
  IconMessageCircle,
  IconMessage2,
  IconFile,
  IconTool,
  IconCircleCheck,
  IconCircleX,
  IconFolder,
  IconFolderOpen,
  IconGitBranch,
  IconArchive,
  IconEye,
  IconEyeOff,
  IconCircle,
  IconLoader,
  IconTrash,
  // File-type icons
  IconFileText,
  IconFileTypePdf,
  IconFileTypeXls,
  IconFileTypePpt,
  IconFileTypeCsv,
  IconFileTypeDoc,
  IconPhoto,
  IconFileCode,
  IconMusic,
  IconVideo,
  IconFileTypeZip,
  // Action icons continued
  IconUpload,
  IconAlertTriangle,
  IconBan,
  IconServer,
  IconPower,
  IconBulb,
  IconHandClick,
  IconCookie,
  IconAt,
  IconStar,
  IconBold,
  IconItalic,
  IconUnderline,
  IconStrikethrough,
  // Bridge icons
  IconWifi,
  IconBrandTelegram,
  IconRefresh,
  // Browser extension icons
  IconBrandChrome,
  IconExternalLink,
  // Attachment menu icons
  IconPaperclip,
  IconBrandGithub,
  IconFeather,
  IconDownload,
  IconArrowBackUp,
  IconTestPipe,
  IconUsersGroup,
  IconBook,
  IconListCheck,
  // Tabler Icons - Agent icons & Channel icons
  IconCardboards,
  IconBrain,
  IconRobot,
  IconLayoutSidebarRight,
  // CodeReviewPanel icons (kept under their original tabler names so the panel
  // can import them from this central file without renaming)
  IconAlertCircle,
  IconColumns2,
  IconFileDiff,
  IconFileMinus,
  IconFilePlus,
  IconFileX,
  IconFold,
  IconGitCompare,
  IconMessagePlus,
  IconRoute,
  IconTextWrap,
} from "@tabler/icons-react";

// Re-export all icons - export names preserved for backward compatibility
export {
  IconArrowUpRight as ArrowUpRightIcon,
  IconArrowLeft as ArrowLeftIcon,
  IconArrowRight as ArrowRightIcon,
  IconBolt as LightningIcon,
  IconWand as MagicWandIcon,
  IconSparkles as SparkleIcon,
  IconHistory as ClockCounterClockwiseIcon,
  IconPlayerPlay as PlayCircleIcon,
  IconRepeat as RepeatIcon,
  IconSettings as GearSixIcon,
  IconKey as KeyIcon,
  IconDeviceDesktop as MonitorIcon,
  IconPlugConnected as PlugIcon,
  IconShieldCheck as ShieldCheckIcon,
  IconCode as CodeIcon,
  IconDatabase as DatabaseIcon,
  IconWorld as GlobeHemisphereWestIcon,
  IconWorld as GlobeIcon,
  IconDots as DotsThreeIcon,
  IconSearch as MagnifyingGlassIcon,
  IconEdit as NotePencilIcon,
  IconPencil as PencilIcon,
  IconLayoutGrid as SquaresFourIcon,
  IconMinimize as CornersInIcon,
  IconMaximize as CornersOutIcon,
  IconSun as SunIcon,
  IconMoon as MoonIcon,
  IconMoonStars as MoonStarsIcon,
  IconSend as PaperPlaneRightIcon,
  IconSend as PaperPlaneTiltIcon,
  IconPlayerStop as StopIcon,
  IconUser as UserIcon,
  IconHome as HouseIcon,
  IconCpu as CpuIcon,
  IconCube as CubeIcon,
  IconLoader2 as SpinnerGapIcon,
  IconInfoCircle as InfoIcon,
  IconShield as ShieldIcon,
  IconX as XIcon,
  IconCommand as CommandIcon,
  IconPlus as PlusIcon,
  IconMinus as MinusIcon,
  IconChevronDown as CaretDownIcon,
  IconChevronLeft as CaretLeftIcon,
  IconChevronRight as CaretRightIcon,
  IconChevronUp as CaretUpIcon,
  IconMicrophone as MicrophoneIcon,
  IconArrowUp as ArrowUpIcon,
  IconTerminal as TerminalIcon,
  IconHelpCircle as QuestionIcon,
  IconEraser as EraserIcon,
  IconChartLine as ChartLineIcon,
  IconChartBar as ChartBarIcon,
  IconWorld as GlobeSimpleIcon,
  IconCopy as CopyIcon,
  IconCheck as CheckIcon,
  IconMessageCircle as ChatCircleIcon,
  IconFile as FileIcon,
  IconTool as WrenchIcon,
  IconCircleCheck as CheckCircleIcon,
  IconCircleX as XCircleIcon,
  IconFolder as FolderIcon,
  IconFolderOpen as FolderOpenIcon,
  IconGitBranch as GitBranchIcon,
  IconArchive as ArchiveIcon,
  IconEye as EyeIcon,
  IconEyeOff as EyeSlashIcon,
  IconCircle as CircleIcon,
  IconLoader as CircleNotchIcon,
  IconTrash as TrashIcon,
  IconFileText as FileTextIcon,
  IconFileTypePdf as FilePdfIcon,
  IconFileTypeXls as FileXlsIcon,
  IconFileTypePpt as FilePptIcon,
  IconFileTypeCsv as FileCsvIcon,
  IconFileTypeDoc as FileDocIcon,
  IconPhoto as FileImageIcon,
  IconFileCode as FileCodeIcon,
  IconMusic as FileAudioIcon,
  IconVideo as FileVideoIcon,
  IconFileTypeZip as FileZipIcon,
  IconUpload as UploadSimpleIcon,
  IconAlertTriangle as WarningIcon,
  IconBan as ProhibitIcon,
  IconServer as HardDrivesIcon,
  IconPower as PowerIcon,
  IconMessage2 as ChatCircleTextIcon,
  IconBulb as LightbulbIcon,
  IconPhoto as ImageIcon,
  IconHandClick as CursorClickIcon,
  IconCookie as CookieIcon,
  IconAt as AtSignIcon,
  IconSearch as SearchIcon,
  IconChevronDown as ChevronDownIcon,
  IconChevronUp as ChevronUpIcon,
  IconStar as StarIcon,
  IconBold as TextBolderIcon,
  IconItalic as TextItalicIcon,
  IconUnderline as TextUnderlineIcon,
  IconStrikethrough as TextStrikethroughIcon,
  // Bridge icons
  IconWifi as WifiHighIcon,
  IconBrandTelegram as TelegramLogoIcon,
  IconRefresh as ArrowsClockwiseIcon,
  // Browser extension icons
  IconBrandChrome as GoogleChromeLogoIcon,
  IconExternalLink as ArrowSquareOutIcon,
  // Attachment menu icons
  IconPaperclip as PaperclipIcon,
  IconBrandGithub as GithubLogoIcon,
  IconFeather as FeatherIcon,
  IconDownload as DownloadSimpleIcon,
  // Reset icon
  IconArrowBackUp as ArrowCounterClockwiseIcon,
  // Plan 204 — provider actions icons
  IconTestPipe as TestTubeIcon,
  IconUsersGroup as UsersThreeIcon,
  IconBook as BookOpenIcon,
  IconListCheck as ListChecksIcon,
  // Tabler Icons - Agent icons (using IconCardboards as main agent icon)
  IconCardboards as RobotIcon,
  IconBrain as BrainIcon,
  IconCode as TablerCodeIcon,
  IconMessageCircle as TablerMessageCircleIcon,
  IconRobot as TablerRobotIcon,
  // Tabler Icons - Channel icons
  IconMessageCircle as ChannelIcon,
  // Browser extension aliases
  IconBrandChrome as ChromeIcon,
  IconExternalLink as ExternalLinkIcon,
  // CodeReviewPanel icons - re-exported under their original tabler names so
  // the panel can import them from this central file unchanged.
  IconAlertCircle,
  IconChevronDown,
  IconColumns2,
  IconCopy,
  IconFileCode,
  IconFileDiff,
  IconFileMinus,
  IconFilePlus,
  IconFileX,
  IconFold,
  IconGitBranch,
  IconGitCompare,
  IconHistory,
  IconLayoutSidebarRight,
  IconMessagePlus,
  IconRefresh,
  IconRoute,
  IconSearch,
  IconTextWrap,
};

// Aliases for backward compatibility - right-hand sides updated to tabler
// import names.
export const ServerIcon = IconServer;
export const MessageCircleIcon = IconMessage2;
export const ZapIcon = IconBolt;
export const PowerOffIcon = IconPower;

// SpinnerIcon is an alias for CircleNotchIcon
export const SpinnerIcon = IconLoader;

// DocumentTextIcon is an alias for FileTextIcon
export const DocumentTextIcon = IconFileText;

// ClockIcon is an alias for ClockCounterClockwiseIcon
export const ClockIcon = IconHistory;

// SidebarRightIcon is an alias for IconLayoutSidebarRight (tabler)
export const SidebarRightIcon = IconLayoutSidebarRight;

// TelescopeIcon has no equivalent in @tabler/icons-react, so we ship a small
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
