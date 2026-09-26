"use client";

// Primary icon library: lucide-react (tree-shaking friendly)
// Fallback: @tabler/icons-react (for icons not in lucide)
//
// All icons re-exported through a thin wrapper that defaults stroke to 1.25
// for a lighter visual weight. Business files keep importing from `@/components/icons` unchanged.
import {
  forwardRef,
  type RefAttributes,
  type ForwardRefExoticComponent,
} from "react";
import type { TablerIcon, IconProps as TablerIconProps } from "@tabler/icons-react";
import type { LucideProps } from "lucide-react";
import {
  // === Lucide icons (primary) ===
  ArrowUpRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDownRight,
  ArrowUpDown,
  Zap,
  Wand,
  Sparkles,
  History,
  Play,
  CirclePlay,
  RotateCcw,
  Repeat,
  Settings,
  Key,
  Monitor,
  Plug,
  ShieldCheck,
  Code,
  Database,
  Globe,
  MoreHorizontal,
  Search,
  Pencil,
  SquarePen,
  LayoutGrid,
  Minimize2,
  Maximize2,
  Sun,
  Moon,
  Send,
  StopCircle,
  User,
  Home,
  Cpu,
  Box,
  Loader2,
  Info,
  Shield,
  X,
  Command,
  Plus,
  Minus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Mic,
  Terminal,
  HelpCircle,
  Eraser,
  LineChart,
  BarChart,
  Copy,
  Check,
  ThumbsUp,
  MessageCircle,
  File,
  Wrench,
  CheckCircle,
  XCircle,
  Folder,
  FolderOpen,
  GitBranch,
  Archive,
  Eye,
  EyeOff,
  Circle,
  Loader,
  Trash,
  FileText,
  Image,
  FileCode,
  Music,
  Video,
  Upload,
  AlertTriangle,
  Ban,
  Server,
  Power,
  Lightbulb,
  AtSign,
  Star,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Wifi,
  RefreshCw,
  ExternalLink,
  Paperclip,
  GitFork,
  Download,
  CornerUpLeft,
  Users,
  BookOpen,
  ListChecks,
  Brain,
  Bot,
  AlertCircle,
  Columns2,
  Columns3,
  ALargeSmall,
  FileDiff,
  FileMinus,
  FilePlus,
  FileX,
  GitCompare,
  MessageCirclePlus,
  WrapText,
  Settings2,
  Bell,
  Square,
  CheckSquare,
  Camera,
  Quote,
  Files,
  ZoomIn,
  ZoomOut,
  FileType2,
  Diamond,
  Hexagon,
  MousePointer,
  Link,
  List,
  StickyNote,
  Pentagon,
  ShieldAlert,
  Table,
  AlignCenter,
  AlignLeft,
  AlignRight,
  Type,
  Triangle,
  Pin,
  Target,
  TestTube,
  CircleDot,
  ChevronsUpDown,
} from "lucide-react";

import {
  // === Tabler icons (fallback for icons not in lucide) ===
  IconArrowLeft as TablerIconArrowLeft,
  IconArrowUp as TablerIconArrowUp,
  IconArrowDownRight as TablerIconArrowDownRight,
  IconArrowsVertical as TablerIconArrowsVertical,
  IconArrowsDiagonalMinimize as TablerIconArrowsDiagonalMinimize,
  IconArrowsMaximize as TablerIconArrowsMaximize,
  IconLayoutGrid as TablerIconLayoutGrid,
  IconCloud as TablerIconCloud,
  IconSun as TablerIconSun,
  IconMoon as TablerIconMoon,
  IconMoonStars as TablerIconMoonStars,
  IconSend as TablerIconSend,
  IconPlayerStop as TablerIconPlayerStop,
  IconUser as TablerIconUser,
  IconHome as TablerIconHome,
  IconCpu as TablerIconCpu,
  IconCube as TablerIconCube,
  IconLoader2 as TablerIconLoader2,
  IconInfoCircle as TablerIconInfoCircle,
  IconShield as TablerIconShield,
  IconX as TablerIconX,
  IconCommand as TablerIconCommand,
  IconPlus as TablerIconPlus,
  IconMinus as TablerIconMinus,
  IconChevronDown as TablerIconChevronDown,
  IconChevronLeft as TablerIconChevronLeft,
  IconChevronRight as TablerIconChevronRight,
  IconChevronUp as TablerIconChevronUp,
  IconMicrophone as TablerIconMicrophone,
  IconTerminal as TablerIconTerminal,
  IconHelpCircle as TablerIconHelpCircle,
  IconEraser as TablerIconEraser,
  IconChartLine as TablerIconChartLine,
  IconChartBar as TablerIconChartBar,
  IconCopy as TablerIconCopy,
  IconCheck as TablerIconCheck,
  IconThumbUp as TablerIconThumbUp,
  IconMessageCircle as TablerIconMessageCircle,
  IconMessageCirclePlus as TablerIconMessageCirclePlus,
  IconMessage2 as TablerIconMessage2,
  IconTool as TablerIconTool,
  IconCircleCheck as TablerIconCircleCheck,
  IconCircleX as TablerIconCircleX,
  IconFolder as TablerIconFolder,
  IconFolderOpen as TablerIconFolderOpen,
  IconGitBranch as TablerIconGitBranch,
  IconWebhook as TablerIconWebhook,
  IconArchive as TablerIconArchive,
  IconEye as TablerIconEye,
  IconEyeOff as TablerIconEyeOff,
  IconCircle as TablerIconCircle,
  IconLoader as TablerIconLoader,
  IconTrash as TablerIconTrash,
  IconFileText as TablerIconFileText,
  IconFileTypePdf as TablerIconFileTypePdf,
  IconFileTypeXls as TablerIconFileTypeXls,
  IconFileTypePpt as TablerIconFileTypePpt,
  IconFileTypeCsv as TablerIconFileTypeCsv,
  IconFileTypeDoc as TablerIconFileTypeDoc,
  IconPhoto as TablerIconPhoto,
  IconMusic as TablerIconMusic,
  IconVideo as TablerIconVideo,
  IconFileTypeZip as TablerIconFileTypeZip,
  IconUpload as TablerIconUpload,
  IconAlertTriangle as TablerIconAlertTriangle,
  IconBan as TablerIconBan,
  IconServer as TablerIconServer,
  IconPower as TablerIconPower,
  IconBulb as TablerIconBulb,
  IconHandClick as TablerIconHandClick,
  IconCookie as TablerIconCookie,
  IconAt as TablerIconAt,
  IconStar as TablerIconStar,
  IconBold as TablerIconBold,
  IconItalic as TablerIconItalic,
  IconUnderline as TablerIconUnderline,
  IconStrikethrough as TablerIconStrikethrough,
  IconWifi as TablerIconWifi,
  IconBrandTelegram as TablerIconBrandTelegram,
  IconRefresh as TablerIconRefresh,
  IconBrandChrome as TablerIconBrandChrome,
  IconExternalLink as TablerIconExternalLink,
  IconPaperclip as TablerIconPaperclip,
  IconBrandGithub as TablerIconBrandGithub,
  IconFeather as TablerIconFeather,
  IconDownload as TablerIconDownload,
  IconArrowBackUp as TablerIconArrowBackUp,
  IconCornerUpLeft as TablerIconCornerUpLeft,
  IconTestPipe as TablerIconTestPipe,
  IconUsersGroup as TablerIconUsersGroup,
  IconBook as TablerIconBook,
  IconListCheck as TablerIconListCheck,
  IconCardboards as TablerIconCardboards,
  IconBrain as TablerIconBrain,
  IconRobot as TablerIconRobot,
  IconLayoutSidebarRight as TablerIconLayoutSidebarRight,
  IconLayoutSidebarLeftCollapse as TablerIconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand as TablerIconLayoutSidebarLeftExpand,
  IconAlertCircle as TablerIconAlertCircle,
  IconColumns2 as TablerIconColumns2,
  IconFileDiff as TablerIconFileDiff,
  IconFileCode as TablerIconFileCode,
  IconSelectAll as TablerIconSelectAll,
  IconFilePlus as TablerIconFilePlus,
  IconFileX as TablerIconFileX,
  IconFold as TablerIconFold,
  IconGitCompare as TablerIconGitCompare,
  IconMessagePlus as TablerIconMessagePlus,
  IconRoute as TablerIconRoute,
  IconTextWrap as TablerIconTextWrap,
  IconAdjustmentsHorizontal as TablerIconAdjustmentsHorizontal,
  IconArrowsVertical as TablerIconArrowsVertical2,
  IconArrowsDiagonalMinimize as TablerIconArrowsDiagonalMinimize2,
  IconArrowsMaximize as TablerIconArrowsMaximize2,
  IconBell as TablerIconBell,
  IconRectangle as TablerIconRectangle,
  IconSquareHalf as TablerIconSquareHalf,
  IconSquareCheck as TablerIconSquareCheck,
  IconCamera as TablerIconCamera,
  IconVector as TablerIconVector,
  IconQuote as TablerIconQuote,
  IconFiles as TablerIconFiles,
  IconFolders as TablerIconFolders,
  IconZoomIn as TablerIconZoomIn,
  IconZoomOut as TablerIconZoomOut,
  IconMarkdown as TablerIconMarkdown,
  IconFileTypeRs as TablerIconFileTypeRs,
  IconFileTypeTs as TablerIconFileTypeTs,
  IconFileTypeJs as TablerIconFileTypeJs,
  IconFileTypeJsx as TablerIconFileTypeJsx,
  IconFileTypeCss as TablerIconFileTypeCss,
  IconFileTypeHtml as TablerIconFileTypeHtml,
  IconFileTypeJpg as TablerIconFileTypeJpg,
  IconFileTypePng as TablerIconFileTypePng,
  IconFileTypeSql as TablerIconFileTypeSql,
  IconFileTypeSvg as TablerIconFileTypeSvg,
  IconFileTypeVue as TablerIconFileTypeVue,
  IconArrowLoopLeft as TablerIconArrowLoopLeft,
  IconArrowLoopRight as TablerIconArrowLoopRight,
  IconArrowElbowRight as TablerIconArrowElbowRight,
  IconVectorBezier as TablerIconVectorBezier,
  IconGripVertical as TablerIconGripVertical,
  IconHandStop as TablerIconHandStop,
  IconBucket as TablerIconBucket,
  IconShieldExclamation as TablerIconShieldExclamation,
  IconSquare as TablerIconSquare,
  IconTable as TablerIconTable,
  IconTypography as TablerIconTypography,
  IconLetterT as TablerIconLetterT,
  IconPin as TablerIconPin,
  IconPinFilled as TablerIconPinFilled,
  IconTargetArrow as TablerIconTargetArrow,
  IconChalkboard as TablerIconChalkboard,
  IconTelescope as TablerIconTelescope,
  IconCircleDotted as TablerIconCircleDotted,
  IconHexagon as TablerIconHexagon,
} from "@tabler/icons-react";

// ─── Unified wrapper types ────────────────────────────────────────────────────
// Both lucide and tabler icons are wrapped so they share a compatible shape.
// stroke is accepted as string | number | undefined to match tabler's wider type
// while remaining compatible with lucide's string-only stroke.

interface IconProps {
  size?: number | string;
  stroke?: number | string;
  className?: string;
  fill?: string;
  style?: React.CSSProperties;
  [key: string]: unknown;
}

type WrappedIconComponent = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;

// ─── Wrapper factories ────────────────────────────────────────────────────────

function wrapLucide(Icon: typeof ArrowUpRight): WrappedIconComponent {
  return forwardRef<SVGSVGElement, IconProps>(function WrappedIcon(props, ref) {
    const { stroke, size, ...rest } = props;
    // IMPORTANT: on a lucide icon, `stroke` is the SVG *color* attribute — the
    // line weight lives in `strokeWidth`. Feeding a width into `stroke` used to
    // write an invalid color onto the svg, which dropped `currentColor` and left
    // icons stuck in the light-theme color on dark themes.
    const parsed = typeof stroke === "number" ? stroke : Number.parseFloat(String(stroke ?? ""));
    const strokeWidth = Number.isFinite(parsed) ? parsed : 1.25;
    return <Icon ref={ref} strokeWidth={strokeWidth} size={size as number | undefined} {...rest} />;
  }) as WrappedIconComponent;
}

function wrapTabler(Icon: TablerIcon): WrappedIconComponent {
  return forwardRef<SVGSVGElement, IconProps>(function WrappedIcon(props, ref) {
    const { stroke, strokeWidth, ...rest } = props;
    // Tabler puts the line weight in `stroke`; `strokeWidth` is accepted as an
    // alias so call sites written against lucide keep working.
    const raw = stroke ?? strokeWidth;
    const parsed = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
    return (
      <Icon ref={ref} stroke={Number.isFinite(parsed) ? parsed : 1.25} {...rest} />
    );
  }) as WrappedIconComponent;
}

// ─── Lucide icons (primary) ───────────────────────────────────────────────────

export const ArrowUpRightIcon = wrapLucide(ArrowUpRight);
export const ArrowLeftIcon = wrapLucide(ArrowLeft);
export const ArrowRightIcon = wrapLucide(ArrowRight);
export const ArrowUpIcon = wrapLucide(ArrowUp);
export const ArrowBendDownRightIcon = wrapLucide(ArrowDownRight);
export const LightningIcon = wrapLucide(Zap);
export const MagicWandIcon = wrapLucide(Wand);
export const SparkleIcon = wrapLucide(Sparkles);
export const ClockCounterClockwiseIcon = wrapLucide(History);
export const PlayCircleIcon = wrapLucide(CirclePlay);
export const RepeatIcon = wrapLucide(Repeat);
export const GearSixIcon = wrapLucide(Settings);
export const KeyIcon = wrapLucide(Key);
export const MonitorIcon = wrapLucide(Monitor);
export const PlugIcon = wrapLucide(Plug);
export const ShieldCheckIcon = wrapLucide(ShieldCheck);
export const CodeIcon = wrapLucide(Code);
export const DatabaseIcon = wrapLucide(Database);
export const GlobeHemisphereWestIcon = wrapLucide(Globe);
export const GlobeIcon = wrapLucide(Globe);
export const DotsThreeIcon = wrapLucide(MoreHorizontal);
export const MagnifyingGlassIcon = wrapLucide(Search);
export const PencilIcon = wrapLucide(Pencil);
export const SquaresFourIcon = wrapLucide(LayoutGrid);
export const CornersInIcon = wrapLucide(Minimize2);
export const CornersOutIcon = wrapLucide(Maximize2);
export const SunIcon = wrapLucide(Sun);
export const MoonIcon = wrapLucide(Moon);
export const MoonStarsIcon = wrapTabler(TablerIconMoonStars);
export const CloudIcon = wrapTabler(TablerIconCloud);
export const ChevronDownIcon = wrapLucide(ChevronDown);
export const ChevronUpIcon = wrapLucide(ChevronUp);
export const PaperPlaneRightIcon = wrapLucide(Send);
export const PaperPlaneTiltIcon = wrapLucide(Send);
export const StopIcon = wrapLucide(StopCircle);
export const UserIcon = wrapLucide(User);
export const HouseIcon = wrapLucide(Home);
export const CpuIcon = wrapLucide(Cpu);
export const CubeIcon = wrapLucide(Box);
export const SpinnerGapIcon = wrapLucide(Loader2);
export const InfoIcon = wrapLucide(Info);
export const ShieldIcon = wrapLucide(Shield);
export const XIcon = wrapLucide(X);
export const CommandIcon = wrapLucide(Command);
export const PlusIcon = wrapLucide(Plus);
export const MinusIcon = wrapLucide(Minus);
export const CaretDownIcon = wrapLucide(ChevronDown);
export const CaretLeftIcon = wrapLucide(ChevronLeft);
export const CaretRightIcon = wrapLucide(ChevronRight);
export const CaretUpIcon = wrapLucide(ChevronUp);
export const MicrophoneIcon = wrapLucide(Mic);
export const TerminalIcon = wrapLucide(Terminal);
export const QuestionIcon = wrapLucide(HelpCircle);
export const EraserIcon = wrapLucide(Eraser);
export const ChartLineIcon = wrapLucide(LineChart);
export const ChartBarIcon = wrapLucide(BarChart);
export const GlobeSimpleIcon = wrapLucide(Globe);
export const CopyIcon = wrapLucide(Copy);
export const CheckIcon = wrapLucide(Check);
export const ThumbsUpIcon = wrapLucide(ThumbsUp);
export const ChatCircleIcon = wrapLucide(MessageCircle);
export const FileIcon = wrapLucide(File);
export const WrenchIcon = wrapLucide(Wrench);
export const CheckCircleIcon = wrapLucide(CheckCircle);
export const XCircleIcon = wrapLucide(XCircle);
export const FolderIcon = wrapLucide(Folder);
export const FolderOpenIcon = wrapLucide(FolderOpen);
export const GitBranchIcon = wrapLucide(GitBranch);
export const ArchiveIcon = wrapLucide(Archive);
export const EyeIcon = wrapLucide(Eye);
export const EyeSlashIcon = wrapLucide(EyeOff);
export const CircleIcon = wrapLucide(Circle);
export const CircleNotchIcon = wrapLucide(Loader);
export const TrashIcon = wrapLucide(Trash);
export const FileTextIcon = wrapLucide(FileText);
export const FileImageIcon = wrapLucide(Image);
export const FileCodeIcon = wrapLucide(FileCode);
export const FileAudioIcon = wrapLucide(Music);
export const FileVideoIcon = wrapLucide(Video);
export const UploadSimpleIcon = wrapLucide(Upload);
export const WarningIcon = wrapLucide(AlertTriangle);
export const ProhibitIcon = wrapLucide(Ban);
export const HardDrivesIcon = wrapLucide(Server);
export const PowerIcon = wrapLucide(Power);
export const LightbulbIcon = wrapLucide(Lightbulb);
export const AtSignIcon = wrapLucide(AtSign);
export const StarIcon = wrapLucide(Star);
export const TextBolderIcon = wrapLucide(Bold);
export const TextItalicIcon = wrapLucide(Italic);
export const TextUnderlineIcon = wrapLucide(Underline);
export const TextStrikethroughIcon = wrapLucide(Strikethrough);
export const WifiHighIcon = wrapLucide(Wifi);
export const ArrowsClockwiseIcon = wrapLucide(RefreshCw);
export const ArrowSquareOutIcon = wrapLucide(ExternalLink);
export const PaperclipIcon = wrapLucide(Paperclip);
// lucide dropped brand icons; the Github mark comes from the tabler fallback
// set, like every other brand logo in this module.
export const GithubLogoIcon = wrapTabler(TablerIconBrandGithub);
export const DownloadSimpleIcon = wrapLucide(Download);
export const ArrowCounterClockwiseIcon = wrapLucide(RotateCcw);
export const ReplyIcon = wrapLucide(CornerUpLeft);
export const TestTubeIcon = wrapLucide(TestTube);
export const UsersThreeIcon = wrapLucide(Users);
export const BookOpenIcon = wrapLucide(BookOpen);
export const ListChecksIcon = wrapLucide(ListChecks);
export const BrainIcon = wrapLucide(Brain);
export const RobotIcon = wrapLucide(Bot);
export const FilePlusIcon = wrapLucide(FilePlus);
export const GridFourIcon = wrapLucide(LayoutGrid);
export const TextBIcon = wrapLucide(Bold);
export const CopySimpleIcon = wrapLucide(Copy);
export const BellIcon = wrapLucide(Bell);
export const SquareIcon = wrapLucide(Square);
export const TriangleIcon = wrapLucide(Triangle);
export const ImageSquareIcon = wrapLucide(Image);
export const DiamondIcon = wrapLucide(Diamond);

// ─── Lucide aliases ───────────────────────────────────────────────────────────

export const PlayIcon = wrapLucide(Play);
export const PencilSimpleIcon = wrapLucide(Pencil);
export const WarningCircleIcon = wrapLucide(AlertCircle);
export const AlertIcon = wrapLucide(AlertCircle);
export const GitDiffIcon = wrapLucide(GitCompare);
export const ArrowClockwiseIcon = wrapLucide(RefreshCw);
export const CheckSquareIcon = wrapLucide(CheckSquare);
export const CameraIcon = wrapLucide(Camera);
export const QuotesIcon = wrapLucide(Quote);
export const FilesIcon = wrapLucide(Files);
export const MagnifyingGlassPlusIcon = wrapLucide(ZoomIn);
export const MagnifyingGlassMinusIcon = wrapLucide(ZoomOut);
export const CursorIcon = wrapLucide(MousePointer);
export const MousePointerClickIcon = wrapLucide(MousePointer);
export const LinkSimpleIcon = wrapLucide(Link);
export const ListBulletsIcon = wrapLucide(List);
export const NoteIcon = wrapLucide(StickyNote);
export const ShieldWarningIcon = wrapLucide(ShieldAlert);
export const TableIcon = wrapLucide(Table);
export const TextAlignCenterIcon = wrapLucide(AlignCenter);
export const TextAlignLeftIcon = wrapLucide(AlignLeft);
export const TextAlignRightIcon = wrapLucide(AlignRight);
// "Aa" is the glyph size/letter-case mark, not a plain letter T (TextTIcon).
export const TextAaIcon = wrapLucide(ALargeSmall);
export const TextTIcon = wrapLucide(Type);
export const TargetArrowIcon = wrapLucide(Target);
export const PinIcon = wrapLucide(Pin);
// Filled pin must actually be the filled variant, otherwise "pin" and "unpin"
// render as the exact same outline glyph.
export const PinFilledIcon = wrapTabler(TablerIconPinFilled);
export const CircleDottedIcon = wrapLucide(CircleDot);

// ─── Tabler-only icons (fallback) ─────────────────────────────────────────────

export const WebhookIcon = wrapTabler(TablerIconWebhook);
export const TelegramLogoIcon = wrapTabler(TablerIconBrandTelegram);
export const GoogleChromeLogoIcon = wrapTabler(TablerIconBrandChrome);
export const FeatherIcon = wrapTabler(TablerIconFeather);
export const ChromeIcon = wrapTabler(TablerIconBrandChrome);
export const ExternalLinkIcon = wrapTabler(TablerIconExternalLink);
export const AiGatewayIcon = wrapTabler(TablerIconWebhook); // alias
export const TablerCodeIcon = wrapLucide(Code);
export const TablerMessageCircleIcon = wrapTabler(TablerIconMessageCircle);
export const TablerRobotIcon = wrapTabler(TablerIconRobot);
export const ChannelIcon = wrapTabler(TablerIconMessageCircle);

// File-type icons — lucide has no good equivalent for these specific file types
export const FilePdfIcon = wrapTabler(TablerIconFileTypePdf);
export const FileXlsIcon = wrapTabler(TablerIconFileTypeXls);
export const FilePptIcon = wrapTabler(TablerIconFileTypePpt);
export const FileCsvIcon = wrapTabler(TablerIconFileTypeCsv);
export const FileDocIcon = wrapTabler(TablerIconFileTypeDoc);
export const FileZipIcon = wrapTabler(TablerIconFileTypeZip);
export const FileMdIcon = wrapTabler(TablerIconMarkdown);
export const FileRsIcon = wrapTabler(TablerIconFileTypeRs);
export const FileTsIcon = wrapTabler(TablerIconFileTypeTs);
export const FileJsIcon = wrapTabler(TablerIconFileTypeJs);
export const FileJsxIcon = wrapTabler(TablerIconFileTypeJsx);
export const FileCssIcon = wrapTabler(TablerIconFileTypeCss);
export const FileHtmlIcon = wrapTabler(TablerIconFileTypeHtml);
export const FileJpgIcon = wrapTabler(TablerIconFileTypeJpg);
export const FilePngIcon = wrapTabler(TablerIconFileTypePng);
export const FileSqlIcon = wrapTabler(TablerIconFileTypeSql);
export const FileSvgIcon = wrapTabler(TablerIconFileTypeSvg);
export const FileVueIcon = wrapTabler(TablerIconFileTypeVue);
// C / C++ / Python have no dedicated glyph in either set — a code file mark is
// far closer than the PDF badge these used to fall back to.
export const FileCIcon = wrapTabler(TablerIconFileCode);
export const FileCppIcon = wrapTabler(TablerIconFileCode);
export const MicrosoftWordLogoIcon = wrapTabler(TablerIconFileTypeDoc);
export const MicrosoftPowerpointLogoIcon = wrapTabler(TablerIconFileTypePpt);
export const MicrosoftExcelLogoIcon = wrapTabler(TablerIconFileTypeXls);

// Conductor renderer icons — not in lucide
export const ArrowArcLeftIcon = wrapTabler(TablerIconArrowLoopLeft);
export const ArrowArcRightIcon = wrapTabler(TablerIconArrowLoopRight);
export const ArrowElbowDownRightIcon = wrapTabler(TablerIconArrowElbowRight);
export const ArrowsInLineVerticalIcon = wrapTabler(TablerIconArrowsVertical2);
export const ArrowsInSimpleIcon = wrapTabler(TablerIconArrowsDiagonalMinimize2);
export const ArrowsOutSimpleIcon = wrapTabler(TablerIconArrowsMaximize2);
export const BezierCurveIcon = wrapTabler(TablerIconVectorBezier);
export const DotsSixVerticalIcon = wrapTabler(TablerIconGripVertical);
export const HandIcon = wrapTabler(TablerIconHandStop);
export const HexagonIcon = wrapLucide(Hexagon);
export const PaintBucketIcon = wrapTabler(TablerIconBucket);
// Neither library ships a parallelogram glyph, so it is drawn inline — a slanted
// four-sided shape, not the bezier/scan marks these used to borrow.
export const ParallelogramIcon = forwardRef<SVGSVGElement, IconProps>(
  function ParallelogramIcon(props, ref) {
    const { size, stroke, strokeWidth, ...rest } = props;
    const iconSize = (size ?? 24) as number | string;
    const iconStroke = (stroke ?? strokeWidth ?? 1.25) as number | string;
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={iconSize}
        height={iconSize}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...(rest as React.SVGProps<SVGSVGElement>)}
      >
        <path d="M9.5 5H21l-4.5 14H4z" />
      </svg>
    );
  },
) as WrappedIconComponent;
export const SelectionAllIcon = wrapTabler(TablerIconSelectAll);
export const SlidersHorizontalIcon = wrapTabler(TablerIconAdjustmentsHorizontal);
export const PathIcon = wrapTabler(TablerIconVector);
export const FoldersIcon = wrapTabler(TablerIconFolders);
export const SquareHalfIcon = wrapTabler(TablerIconSquareHalf);
export const RectangleIcon = wrapTabler(TablerIconRectangle);
export const ChalkboardIcon = wrapTabler(TablerIconChalkboard);
export const TelescopeIcon = wrapTabler(TablerIconTelescope);
export const ArrowsOutIcon = wrapTabler(TablerIconArrowsMaximize2);

// Plan 331 Phase 4 pin icons — use tabler for both outline and filled
export const PinIconTabler = wrapTabler(TablerIconPin);
export const PinFilledIconTabler = wrapTabler(TablerIconPinFilled);

// Chat/Message icons — tabler variants for specific use cases
export const ChatCircleTextIcon = wrapTabler(TablerIconMessage2);
export const ChatCirclePlusIcon = wrapTabler(TablerIconMessageCirclePlus);
export const ImageIcon = wrapTabler(TablerIconPhoto);
export const CursorClickIcon = wrapTabler(TablerIconHandClick);
export const CookieIcon = wrapTabler(TablerIconCookie);
// Search — must be a magnifier; previously aliased to a chat bubble, which made
// every search affordance render the wrong glyph.
export const SearchIcon = wrapLucide(Search);

// NotePencilIcon — an "edit" pencil over a note, not a chat bubble.
export const NotePencilIcon = wrapLucide(SquarePen);

// IconLayoutSidebarRight — tabler for CodeReviewPanel
export const IconLayoutSidebarRight = wrapTabler(TablerIconLayoutSidebarRight);

// ─── CodeReviewPanel icons (tabler names exported as-is per AGENTS.md) ─────────

export const IconAlertCircle = wrapLucide(AlertCircle);
export const IconChevronDown = wrapLucide(ChevronDown);
export const IconChevronLeft = wrapLucide(ChevronLeft);
export const IconChevronRight = wrapLucide(ChevronRight);
export const IconColumns2 = wrapLucide(Columns2);
export const IconCopy = wrapLucide(Copy);
export const IconDots = wrapLucide(MoreHorizontal);
export const IconInfoCircle = wrapLucide(Info);
export const IconFileCode = wrapLucide(FileCode);
export const IconFileDiff = wrapLucide(FileDiff);
export const IconFileMinus = wrapLucide(FileMinus);
export const IconFilePlus = wrapLucide(FilePlus);
export const IconFileX = wrapLucide(FileX);
export const IconFold = wrapTabler(TablerIconFold);
export const IconGitBranch = wrapLucide(GitBranch);
export const IconGitCompare = wrapLucide(GitCompare);
export const IconHistory = wrapLucide(History);
export const IconMessagePlus = wrapLucide(MessageCirclePlus);
export const IconRefresh = wrapLucide(RefreshCw);
export const IconRoute = wrapTabler(TablerIconRoute);
export const IconSearch = wrapLucide(Search);
export const IconTextWrap = wrapLucide(WrapText);

// ─── Backward-compatibility aliases ──────────────────────────────────────────

export const ServerIcon = wrapLucide(Server);
export const MessageCircleIcon = wrapTabler(TablerIconMessage2);
export const ZapIcon = wrapLucide(Zap);
export const PowerOffIcon = wrapLucide(Power);
export const SpinnerIcon = wrapLucide(Loader);
export const DocumentTextIcon = wrapLucide(FileText);
export const ClockIcon = wrapLucide(History);
export const SidebarRightIcon = wrapTabler(TablerIconLayoutSidebarRight);
// Mirror ZCode's `WorkspaceSidebarCollapsedRail` semantics: the toggle
// points one way when the panel is open (click to collapse) and the
// other when it is closed (click to expand). Used by PanelZone's
// `panel-edge-toggle`.
export const SidebarLeftCollapseIcon = wrapTabler(TablerIconLayoutSidebarLeftCollapse);
export const SidebarLeftExpandIcon = wrapTabler(TablerIconLayoutSidebarLeftExpand);

// File type fallbacks — no good lucide equivalent
export const FilePyIcon = wrapTabler(TablerIconFileCode); // no Python glyph
export const FileIniIcon = wrapLucide(FileText);

// ─── Unified Icon type for consumers ─────────────────────────────────────────
// Both lucide-wrapped and tabler-wrapped components are compatible with this type.

export type { IconProps };
export type Icon = WrappedIconComponent;
