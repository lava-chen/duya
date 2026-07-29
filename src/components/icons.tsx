"use client";

// All icons now sourced from @tabler/icons-react. Export names are preserved
// so business files keep importing `XxxIcon` from `@/components/icons` unchanged.
// We re-export every icon through a thin wrapper that defaults stroke to 1.25,
// which gives a lighter visual weight than tabler's default 2px.
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type RefAttributes,
  type ForwardRefExoticComponent,
} from "react";
import type { TablerIcon, IconProps as TablerIconProps } from "@tabler/icons-react";
import {
  // Original phosphor-equivalent icons
  IconArrowUpRight,
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconBolt,
  IconWand,
  IconSparkles,
  IconHistory as TablerIconHistory,
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
  IconSearch as TablerIconSearch,
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
  IconChevronDown as TablerIconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconMicrophone,
  IconTerminal,
  IconHelpCircle,
  IconEraser,
  IconChartLine,
  IconChartBar,
  IconCopy as TablerIconCopy,
  IconCheck,
  IconMessageCircle,
  IconMessage2,
  IconFile,
  IconTool,
  IconCircleCheck,
  IconCircleX,
  IconFolder,
  IconFolderOpen,
  IconGitBranch as TablerIconGitBranch,
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
  IconFileCode as TablerIconFileCode,
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
  IconRefresh as TablerIconRefresh,
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
  IconLayoutSidebarRight as TablerIconLayoutSidebarRight,
  // CodeReviewPanel icons (kept under their original tabler names so the panel
  // can import them from this central file without renaming)
  IconAlertCircle as TablerIconAlertCircle,
  IconColumns2 as TablerIconColumns2,
  IconFileDiff as TablerIconFileDiff,
  IconFileMinus as TablerIconFileMinus,
  IconFilePlus as TablerIconFilePlus,
  IconFileX as TablerIconFileX,
  IconFold as TablerIconFold,
  IconGitCompare as TablerIconGitCompare,
  IconMessagePlus as TablerIconMessagePlus,
  IconRoute as TablerIconRoute,
  IconTextWrap as TablerIconTextWrap,
  // Business file icons — added for phosphor→tabler migration
  IconAdjustmentsHorizontal,
  IconArrowDownRight,
  IconArrowsVertical,
  IconArrowsDiagonalMinimize,
  IconArrowsMaximize,
  IconBell,
  IconRectangle,
  IconSquareHalf,
  IconSquareCheck,
  IconCamera,
  IconVector,
  IconQuote,
  IconFiles,
  IconZoomIn,
  IconZoomOut,
  IconMarkdown,
  IconFileTypeRs,
  IconFileTypeTs,
  IconFileTypeJs,
  IconFileTypeJsx,
  IconFileTypeCss,
  IconFileTypeHtml,
  IconFileTypeJpg,
  IconFileTypePng,
  IconFileTypeSql,
  IconFileTypeSvg,
  IconFileTypeVue,
  // Conductor renderer icons — added for phosphor→tabler migration (plan 2nd batch)
  IconArrowLoopLeft,
  IconArrowLoopRight,
  IconArrowElbowRight,
  IconVectorBezier,
  IconDiamond,
  IconGripVertical,
  IconHandStop,
  IconHexagon,
  IconPointer,
  IconLink,
  IconList,
  IconNote,
  IconBucket,
  IconPolygon,
  IconScan,
  IconShieldExclamation,
  IconSquare,
  IconTable,
  IconTypography,
  IconAlignCenter,
  IconAlignLeft,
  IconAlignRight,
  IconLetterT,
  IconTriangle,
} from "@tabler/icons-react";

// Thin wrapper around tabler icons. Defaults stroke to 1.25 for a lighter
// look. Call sites can still override stroke/size/color as before.
type IconComponent = ForwardRefExoticComponent<TablerIconProps & RefAttributes<SVGSVGElement>>;

function wrapIcon(Icon: TablerIcon): IconComponent {
  return forwardRef<SVGSVGElement, TablerIconProps>(function WrappedIcon(props, ref) {
    const { stroke, ...rest } = props;
    return <Icon ref={ref} stroke={stroke ?? 1.25} {...rest} />;
  }) as IconComponent;
}

export const ArrowUpRightIcon = wrapIcon(IconArrowUpRight);
export const ArrowLeftIcon = wrapIcon(IconArrowLeft);
export const ArrowRightIcon = wrapIcon(IconArrowRight);
export const LightningIcon = wrapIcon(IconBolt);
export const MagicWandIcon = wrapIcon(IconWand);
export const SparkleIcon = wrapIcon(IconSparkles);
export const ClockCounterClockwiseIcon = wrapIcon(TablerIconHistory);
export const PlayCircleIcon = wrapIcon(IconPlayerPlay);
export const RepeatIcon = wrapIcon(IconRepeat);
export const GearSixIcon = wrapIcon(IconSettings);
export const KeyIcon = wrapIcon(IconKey);
export const MonitorIcon = wrapIcon(IconDeviceDesktop);
export const PlugIcon = wrapIcon(IconPlugConnected);
export const ShieldCheckIcon = wrapIcon(IconShieldCheck);
export const CodeIcon = wrapIcon(IconCode);
export const DatabaseIcon = wrapIcon(IconDatabase);
export const GlobeHemisphereWestIcon = wrapIcon(IconWorld);
export const GlobeIcon = wrapIcon(IconWorld);
export const DotsThreeIcon = wrapIcon(IconDots);
export const MagnifyingGlassIcon = wrapIcon(TablerIconSearch);
export const NotePencilIcon = wrapIcon(IconEdit);
export const PencilIcon = wrapIcon(IconPencil);
export const SquaresFourIcon = wrapIcon(IconLayoutGrid);
export const CornersInIcon = wrapIcon(IconMinimize);
export const CornersOutIcon = wrapIcon(IconMaximize);
export const SunIcon = wrapIcon(IconSun);
export const MoonIcon = wrapIcon(IconMoon);
export const MoonStarsIcon = wrapIcon(IconMoonStars);
export const PaperPlaneRightIcon = wrapIcon(IconSend);
export const PaperPlaneTiltIcon = wrapIcon(IconSend);
export const StopIcon = wrapIcon(IconPlayerStop);
export const UserIcon = wrapIcon(IconUser);
export const HouseIcon = wrapIcon(IconHome);
export const CpuIcon = wrapIcon(IconCpu);
export const CubeIcon = wrapIcon(IconCube);
export const SpinnerGapIcon = wrapIcon(IconLoader2);
export const InfoIcon = wrapIcon(IconInfoCircle);
export const ShieldIcon = wrapIcon(IconShield);
export const XIcon = wrapIcon(IconX);
export const CommandIcon = wrapIcon(IconCommand);
export const PlusIcon = wrapIcon(IconPlus);
export const MinusIcon = wrapIcon(IconMinus);
export const CaretDownIcon = wrapIcon(TablerIconChevronDown);
export const CaretLeftIcon = wrapIcon(IconChevronLeft);
export const CaretRightIcon = wrapIcon(IconChevronRight);
export const CaretUpIcon = wrapIcon(IconChevronUp);
export const MicrophoneIcon = wrapIcon(IconMicrophone);
export const ArrowUpIcon = wrapIcon(IconArrowUp);
export const TerminalIcon = wrapIcon(IconTerminal);
export const QuestionIcon = wrapIcon(IconHelpCircle);
export const EraserIcon = wrapIcon(IconEraser);
export const ChartLineIcon = wrapIcon(IconChartLine);
export const ChartBarIcon = wrapIcon(IconChartBar);
export const GlobeSimpleIcon = wrapIcon(IconWorld);
export const CopyIcon = wrapIcon(TablerIconCopy);
export const CheckIcon = wrapIcon(IconCheck);
export const ChatCircleIcon = wrapIcon(IconMessageCircle);
export const FileIcon = wrapIcon(IconFile);
export const WrenchIcon = wrapIcon(IconTool);
export const CheckCircleIcon = wrapIcon(IconCircleCheck);
export const XCircleIcon = wrapIcon(IconCircleX);
export const FolderIcon = wrapIcon(IconFolder);
export const FolderOpenIcon = wrapIcon(IconFolderOpen);
export const GitBranchIcon = wrapIcon(TablerIconGitBranch);
export const ArchiveIcon = wrapIcon(IconArchive);
export const EyeIcon = wrapIcon(IconEye);
export const EyeSlashIcon = wrapIcon(IconEyeOff);
export const CircleIcon = wrapIcon(IconCircle);
export const CircleNotchIcon = wrapIcon(IconLoader);
export const TrashIcon = wrapIcon(IconTrash);
export const FileTextIcon = wrapIcon(IconFileText);
export const FilePdfIcon = wrapIcon(IconFileTypePdf);
export const FileXlsIcon = wrapIcon(IconFileTypeXls);
export const FilePptIcon = wrapIcon(IconFileTypePpt);
export const FileCsvIcon = wrapIcon(IconFileTypeCsv);
export const FileDocIcon = wrapIcon(IconFileTypeDoc);
export const FileImageIcon = wrapIcon(IconPhoto);
export const FileCodeIcon = wrapIcon(TablerIconFileCode);
export const FileAudioIcon = wrapIcon(IconMusic);
export const FileVideoIcon = wrapIcon(IconVideo);
export const FileZipIcon = wrapIcon(IconFileTypeZip);
export const UploadSimpleIcon = wrapIcon(IconUpload);
export const WarningIcon = wrapIcon(IconAlertTriangle);
export const ProhibitIcon = wrapIcon(IconBan);
export const HardDrivesIcon = wrapIcon(IconServer);
export const PowerIcon = wrapIcon(IconPower);
export const ChatCircleTextIcon = wrapIcon(IconMessage2);
export const LightbulbIcon = wrapIcon(IconBulb);
export const ImageIcon = wrapIcon(IconPhoto);
export const CursorClickIcon = wrapIcon(IconHandClick);
export const CookieIcon = wrapIcon(IconCookie);
export const AtSignIcon = wrapIcon(IconAt);
export const SearchIcon = wrapIcon(TablerIconSearch);
export const ChevronDownIcon = wrapIcon(TablerIconChevronDown);
export const ChevronUpIcon = wrapIcon(IconChevronUp);
export const StarIcon = wrapIcon(IconStar);
export const TextBolderIcon = wrapIcon(IconBold);
export const TextItalicIcon = wrapIcon(IconItalic);
export const TextUnderlineIcon = wrapIcon(IconUnderline);
export const TextStrikethroughIcon = wrapIcon(IconStrikethrough);
  // Bridge icons
export const WifiHighIcon = wrapIcon(IconWifi);
export const TelegramLogoIcon = wrapIcon(IconBrandTelegram);
export const ArrowsClockwiseIcon = wrapIcon(TablerIconRefresh);
  // Browser extension icons
export const GoogleChromeLogoIcon = wrapIcon(IconBrandChrome);
export const ArrowSquareOutIcon = wrapIcon(IconExternalLink);
  // Attachment menu icons
export const PaperclipIcon = wrapIcon(IconPaperclip);
export const GithubLogoIcon = wrapIcon(IconBrandGithub);
export const FeatherIcon = wrapIcon(IconFeather);
export const DownloadSimpleIcon = wrapIcon(IconDownload);
  // Reset icon
export const ArrowCounterClockwiseIcon = wrapIcon(IconArrowBackUp);
  // Plan 204 — provider actions icons
export const TestTubeIcon = wrapIcon(IconTestPipe);
export const UsersThreeIcon = wrapIcon(IconUsersGroup);
export const BookOpenIcon = wrapIcon(IconBook);
export const ListChecksIcon = wrapIcon(IconListCheck);
  // Tabler Icons - Agent icons (using IconCardboards as main agent icon)
export const RobotIcon = wrapIcon(IconCardboards);
export const BrainIcon = wrapIcon(IconBrain);
export const TablerCodeIcon = wrapIcon(IconCode);
export const TablerMessageCircleIcon = wrapIcon(IconMessageCircle);
export const TablerRobotIcon = wrapIcon(IconRobot);
  // Tabler Icons - Channel icons
export const ChannelIcon = wrapIcon(IconMessageCircle);
  // Browser extension aliases
export const ChromeIcon = wrapIcon(IconBrandChrome);
export const ExternalLinkIcon = wrapIcon(IconExternalLink);
  // CodeReviewPanel icons - re-exported under their original tabler names so
  // the panel can import them from this central file unchanged.
export const IconAlertCircle = wrapIcon(TablerIconAlertCircle);
export const IconChevronDown = wrapIcon(TablerIconChevronDown);
export const IconColumns2 = wrapIcon(TablerIconColumns2);
export const IconCopy = wrapIcon(TablerIconCopy);
export const IconFileCode = wrapIcon(TablerIconFileCode);
export const IconFileDiff = wrapIcon(TablerIconFileDiff);
export const IconFileMinus = wrapIcon(TablerIconFileMinus);
export const IconFilePlus = wrapIcon(TablerIconFilePlus);
export const IconFileX = wrapIcon(TablerIconFileX);
export const IconFold = wrapIcon(TablerIconFold);
export const IconGitBranch = wrapIcon(TablerIconGitBranch);
export const IconGitCompare = wrapIcon(TablerIconGitCompare);
export const IconHistory = wrapIcon(TablerIconHistory);
export const IconLayoutSidebarRight = wrapIcon(TablerIconLayoutSidebarRight);
export const IconMessagePlus = wrapIcon(TablerIconMessagePlus);
export const IconRefresh = wrapIcon(TablerIconRefresh);
export const IconRoute = wrapIcon(TablerIconRoute);
export const IconSearch = wrapIcon(TablerIconSearch);
export const IconTextWrap = wrapIcon(TablerIconTextWrap);
  // Business file icons — phosphor-name aliases for tabler icons
export const PlayIcon = wrapIcon(IconPlayerPlay);
export const PencilSimpleIcon = wrapIcon(IconPencil);
export const WarningCircleIcon = wrapIcon(TablerIconAlertCircle);
export const GitDiffIcon = wrapIcon(TablerIconGitCompare);
export const ArrowClockwiseIcon = wrapIcon(TablerIconRefresh);
export const SlidersHorizontalIcon = wrapIcon(IconAdjustmentsHorizontal);
export const ArrowBendDownRightIcon = wrapIcon(IconArrowDownRight);
export const ArrowsInLineVerticalIcon = wrapIcon(IconArrowsVertical);
export const ArrowsInSimpleIcon = wrapIcon(IconArrowsDiagonalMinimize);
export const ArrowsOutSimpleIcon = wrapIcon(IconArrowsMaximize);
export const SquareHalfIcon = wrapIcon(IconSquareHalf);
export const CheckSquareIcon = wrapIcon(IconSquareCheck);
export const CameraIcon = wrapIcon(IconCamera);
export const PathIcon = wrapIcon(IconVector);
export const QuotesIcon = wrapIcon(IconQuote);
export const FilesIcon = wrapIcon(IconFiles);
export const MagnifyingGlassPlusIcon = wrapIcon(IconZoomIn);
export const MagnifyingGlassMinusIcon = wrapIcon(IconZoomOut);
export const FileMdIcon = wrapIcon(IconMarkdown);
export const FileRsIcon = wrapIcon(IconFileTypeRs);
export const FileTsIcon = wrapIcon(IconFileTypeTs);
export const FileJsIcon = wrapIcon(IconFileTypeJs);
export const FileJsxIcon = wrapIcon(IconFileTypeJsx);
export const FileCssIcon = wrapIcon(IconFileTypeCss);
export const FileHtmlIcon = wrapIcon(IconFileTypeHtml);
export const FileJpgIcon = wrapIcon(IconFileTypeJpg);
export const FilePngIcon = wrapIcon(IconFileTypePng);
export const FileSqlIcon = wrapIcon(IconFileTypeSql);
export const FileSvgIcon = wrapIcon(IconFileTypeSvg);
export const FileVueIcon = wrapIcon(IconFileTypeVue);
export const FileCIcon = wrapIcon(TablerIconFileCode);
export const FileCppIcon = wrapIcon(TablerIconFileCode);
export const MicrosoftWordLogoIcon = wrapIcon(IconFileTypeDoc);
export const MicrosoftPowerpointLogoIcon = wrapIcon(IconFileTypePpt);
export const MicrosoftExcelLogoIcon = wrapIcon(IconFileTypeXls);
  // Conductor renderer icons — added for phosphor→tabler migration (plan 2nd batch)
export const ArrowArcLeftIcon = wrapIcon(IconArrowLoopLeft);
export const ArrowArcRightIcon = wrapIcon(IconArrowLoopRight);
export const ArrowElbowDownRightIcon = wrapIcon(IconArrowElbowRight);
export const ArrowsOutIcon = wrapIcon(IconArrowsMaximize);
export const BezierCurveIcon = wrapIcon(IconVectorBezier);
export const DiamondIcon = wrapIcon(IconDiamond);
export const DotsSixVerticalIcon = wrapIcon(IconGripVertical);
export const HandIcon = wrapIcon(IconHandStop);
export const HexagonIcon = wrapIcon(IconHexagon);
export const CursorIcon = wrapIcon(IconPointer);
export const LinkSimpleIcon = wrapIcon(IconLink);
export const ListBulletsIcon = wrapIcon(IconList);
export const NoteIcon = wrapIcon(IconNote);
export const PaintBucketIcon = wrapIcon(IconBucket);
export const ParallelogramIcon = wrapIcon(IconPolygon);
export const SelectionAllIcon = wrapIcon(IconScan);
export const ShieldWarningIcon = wrapIcon(IconShieldExclamation);
export const SquareIcon = wrapIcon(IconSquare);
export const TableIcon = wrapIcon(IconTable);
export const TextAaIcon = wrapIcon(IconTypography);
export const TextAlignCenterIcon = wrapIcon(IconAlignCenter);
export const TextAlignLeftIcon = wrapIcon(IconAlignLeft);
export const TextAlignRightIcon = wrapIcon(IconAlignRight);
export const TextTIcon = wrapIcon(IconLetterT);
export const TriangleIcon = wrapIcon(IconTriangle);
export const ImageSquareIcon = wrapIcon(IconPhoto);
export const FilePlusIcon = wrapIcon(TablerIconFilePlus);
export const GridFourIcon = wrapIcon(IconLayoutGrid);
export const TextBIcon = wrapIcon(IconBold);
export const CopySimpleIcon = wrapIcon(TablerIconCopy);
export const BellIcon = wrapIcon(IconBell);
export const RectangleIcon = wrapIcon(IconRectangle);

// Aliases for backward compatibility - right-hand sides updated to tabler
// import names.
export const ServerIcon = wrapIcon(IconServer);
export const MessageCircleIcon = wrapIcon(IconMessage2);
export const ZapIcon = wrapIcon(IconBolt);
export const PowerOffIcon = wrapIcon(IconPower);

// SpinnerIcon is an alias for CircleNotchIcon
export const SpinnerIcon = wrapIcon(IconLoader);

// DocumentTextIcon is an alias for FileTextIcon
export const DocumentTextIcon = wrapIcon(IconFileText);

// ClockIcon is an alias for ClockCounterClockwiseIcon
export const ClockIcon = wrapIcon(TablerIconHistory);

// SidebarRightIcon is an alias for IconLayoutSidebarRight (tabler)
export const SidebarRightIcon = wrapIcon(TablerIconLayoutSidebarRight);

// FilePyIcon: Tabler has no Python file-type icon, use generic code file icon
export const FilePyIcon = wrapIcon(TablerIconFileCode);
// FileIniIcon: Tabler has no INI file-type icon, use generic text file icon
export const FileIniIcon = wrapIcon(IconFileText);

// TelescopeIcon has no equivalent in @tabler/icons-react, so we ship a small
// inline SVG instead. Shape: a tilted telescope tube on a tripod stand.
// Matches the IconProps contract used by every other icon in this file so
// `size`, `color`, and standard SVG attributes pass through unchanged.
type TelescopeIconProps = ComponentPropsWithoutRef<'svg'> & RefAttributes<SVGSVGElement> & {
  size?: string | number;
  color?: string;
};
export const TelescopeIcon = forwardRef<SVGSVGElement, TelescopeIconProps>(
  ({ size = 16, color = 'currentColor', stroke = 1.25, ...rest }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      stroke={color}
      strokeWidth={typeof stroke === 'number' ? (stroke * 12.8) : stroke}
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

export type { Icon, IconProps } from "@tabler/icons-react";
