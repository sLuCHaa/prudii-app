// Prudiis Icon-Set: Phosphor Duotone, ausgeliefert unter den Namen, die der
// Code seit lucide-react kennt. Damit endet ein Set-Wechsel an dieser Datei.
//
// Duotone heißt bei Phosphor: Silhouette mit heller Fläche, darüber die Kontur
// (1,5 px auf dem 24er-Raster). Die Fläche hebt index.css von 20 auf 28 % an,
// damit die Formen bei 16 px nicht zerfallen.
import { forwardRef, type ForwardRefExoticComponent, type RefAttributes } from "react";
import type { Icon as PhosphorIcon, IconProps as PhosphorIconProps, IconWeight } from "@phosphor-icons/react";
import {
  AirplaneTiltIcon,
  AppWindowIcon,
  AppleLogoIcon,
  ArchiveIcon,
  ArrowBendDoubleUpLeftIcon,
  ArrowBendUpLeftIcon,
  ArrowBendUpRightIcon,
  ArrowCounterClockwiseIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  ArrowUUpLeftIcon,
  ArrowUUpRightIcon,
  ArrowUpIcon,
  ArrowsClockwiseIcon,
  ArrowsDownUpIcon,
  BellIcon,
  BellSlashIcon,
  BriefcaseIcon,
  CalendarBlankIcon,
  CalendarDotIcon,
  CalendarDotsIcon,
  CalendarPlusIcon,
  CalendarXIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpIcon,
  ChatTeardropTextIcon,
  ChatsIcon,
  CheckCircleIcon,
  CheckIcon,
  CircleDashedIcon,
  CircleIcon,
  ClipboardTextIcon,
  ClockIcon,
  CloudIcon,
  CodeIcon,
  CopyIcon,
  CrownIcon,
  DatabaseIcon,
  DotsSixVerticalIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  EnvelopeOpenIcon,
  EnvelopeSimpleIcon,
  EnvelopeSimpleOpenIcon,
  EraserIcon,
  ExportIcon,
  EyeIcon,
  EyeSlashIcon,
  FileArrowUpIcon,
  FileCodeIcon,
  FileIcon,
  FileTextIcon,
  FileTxtIcon,
  FileXIcon,
  FileXlsIcon,
  FilmStripIcon,
  FlagIcon,
  FlameIcon,
  FloppyDiskIcon,
  FolderNotchOpenIcon,
  FolderOpenIcon,
  FolderSimpleIcon,
  FolderSimplePlusIcon,
  FunnelIcon,
  GearSixIcon,
  GlobeIcon,
  HardDriveIcon,
  HardDrivesIcon,
  ImageBrokenIcon,
  ImageIcon,
  ImageSquareIcon,
  InfoIcon,
  KeyIcon,
  LinkSimpleBreakIcon,
  LinkSimpleIcon,
  ListBulletsIcon,
  ListChecksIcon,
  ListNumbersIcon,
  ListPlusIcon,
  LockIcon,
  MagnifyingGlassIcon,
  MapPinIcon,
  MinusIcon,
  MonitorIcon,
  MoonIcon,
  MusicNoteIcon,
  PaletteIcon,
  PaperPlaneTiltIcon,
  PaperclipIcon,
  PencilSimpleIcon,
  PencilSimpleLineIcon,
  PlantIcon,
  PlusIcon,
  PowerIcon,
  PrinterIcon,
  ProhibitIcon,
  PushPinIcon,
  PushPinSlashIcon,
  QuestionIcon,
  QuotesIcon,
  RepeatIcon,
  RssIcon,
  ScissorsIcon,
  SealCheckIcon,
  ShieldIcon,
  ShieldWarningIcon,
  SidebarSimpleIcon,
  SignOutIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
  SpeakerHighIcon,
  SquareIcon,
  SquaresFourIcon,
  StarIcon,
  SunIcon,
  TagIcon,
  TagSimpleIcon,
  TextAlignLeftIcon,
  TextBIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  TextTIcon,
  TextTSlashIcon,
  TranslateIcon,
  TrashIcon,
  TrayIcon,
  UploadSimpleIcon,
  UserCheckIcon,
  UserIcon,
  UserMinusIcon,
  UsersIcon,
  VideoCameraIcon,
  WarningCircleIcon,
  WarningIcon,
  WarningOctagonIcon,
  WifiSlashIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";

export interface IconProps extends Omit<PhosphorIconProps, "ref" | "strokeWidth"> {
  /** Lucide-Erbe: ab 2.4 wird das Icon fett, darunter bleibt es Duotone. */
  strokeWidth?: number | string;
}

export type IconComponent = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;

export function weightFor(strokeWidth: number | string | undefined): IconWeight {
  return strokeWidth !== undefined && Number(strokeWidth) >= 2.4 ? "bold" : "duotone";
}

function duotone(Base: PhosphorIcon, name: string, defaults: Partial<IconProps> = {}): IconComponent {
  // Keine Lookbehind-Regex: ältere WebKit-Versionen (vor Safari 16.4) parsen sie nicht.
  const iconClass = `pi pi-${name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`;
  const Icon = forwardRef<SVGSVGElement, IconProps>(function PrudiiIcon(
    { strokeWidth, weight, size = 24, className, ...rest },
    ref,
  ) {
    const labelled = rest["aria-label"] !== undefined || rest.alt !== undefined;
    return (
      <Base
        ref={ref}
        size={size}
        weight={weight ?? weightFor(strokeWidth)}
        aria-hidden={labelled ? undefined : true}
        {...defaults}
        {...rest}
        className={className ? `${iconClass} ${className}` : iconClass}
      />
    );
  });
  Icon.displayName = name;
  return Icon;
}

export const AlertCircle = duotone(WarningCircleIcon, "AlertCircle");
export const AlertOctagon = duotone(WarningOctagonIcon, "AlertOctagon");
export const AlertTriangle = duotone(WarningIcon, "AlertTriangle");
export const AlignLeft = duotone(TextAlignLeftIcon, "AlignLeft");
export const AppWindow = duotone(AppWindowIcon, "AppWindow");
export const Apple = duotone(AppleLogoIcon, "Apple");
export const Archive = duotone(ArchiveIcon, "Archive");
export const ArrowDown = duotone(ArrowDownIcon, "ArrowDown");
export const ArrowLeft = duotone(ArrowLeftIcon, "ArrowLeft");
export const ArrowUp = duotone(ArrowUpIcon, "ArrowUp");
export const ArrowUpDown = duotone(ArrowsDownUpIcon, "ArrowUpDown");
export const Bell = duotone(BellIcon, "Bell");
export const BellOff = duotone(BellSlashIcon, "BellOff");
export const Bold = duotone(TextBIcon, "Bold");
export const Briefcase = duotone(BriefcaseIcon, "Briefcase");
export const CalendarClock = duotone(CalendarDotIcon, "CalendarClock");
export const CalendarDays = duotone(CalendarDotsIcon, "CalendarDays");
export const CalendarPlus = duotone(CalendarPlusIcon, "CalendarPlus");
export const CalendarRange = duotone(CalendarBlankIcon, "CalendarRange");
export const CalendarX = duotone(CalendarXIcon, "CalendarX");
export const Check = duotone(CheckIcon, "Check");
export const CheckCircle = duotone(CheckCircleIcon, "CheckCircle");
export const CheckCircle2 = duotone(CheckCircleIcon, "CheckCircle2");
export const ChevronDown = duotone(CaretDownIcon, "ChevronDown");
export const ChevronLeft = duotone(CaretLeftIcon, "ChevronLeft");
export const ChevronRight = duotone(CaretRightIcon, "ChevronRight");
export const ChevronUp = duotone(CaretUpIcon, "ChevronUp");
export const Circle = duotone(CircleIcon, "Circle");
export const CircleDashed = duotone(CircleDashedIcon, "CircleDashed");
export const ClipboardList = duotone(ClipboardTextIcon, "ClipboardList");
export const ClipboardPlus = duotone(ListPlusIcon, "ClipboardPlus");
export const Clock = duotone(ClockIcon, "Clock");
export const Cloud = duotone(CloudIcon, "Cloud");
export const Code = duotone(CodeIcon, "Code");
export const Copy = duotone(CopyIcon, "Copy");
export const Crown = duotone(CrownIcon, "Crown");
export const Database = duotone(DatabaseIcon, "Database");
export const Download = duotone(DownloadSimpleIcon, "Download");
export const Edit3 = duotone(PencilSimpleLineIcon, "Edit3");
export const Ellipsis = duotone(DotsThreeIcon, "Ellipsis");
export const ExternalLink = duotone(ArrowSquareOutIcon, "ExternalLink");
export const Eye = duotone(EyeIcon, "Eye");
export const EyeOff = duotone(EyeSlashIcon, "EyeOff");
export const File = duotone(FileIcon, "File");
export const FileCode = duotone(FileCodeIcon, "FileCode");
export const FileSpreadsheet = duotone(FileXlsIcon, "FileSpreadsheet");
export const FileText = duotone(FileTextIcon, "FileText");
export const FileType = duotone(FileTxtIcon, "FileType");
export const FileUp = duotone(FileArrowUpIcon, "FileUp");
export const FileWarning = duotone(FileXIcon, "FileWarning");
export const Film = duotone(FilmStripIcon, "Film");
export const Filter = duotone(FunnelIcon, "Filter");
export const Flag = duotone(FlagIcon, "Flag");
export const FlagOff = duotone(EraserIcon, "FlagOff");
export const Flame = duotone(FlameIcon, "Flame");
export const Folder = duotone(FolderSimpleIcon, "Folder");
export const FolderDown = duotone(ExportIcon, "FolderDown");
export const FolderInput = duotone(FolderNotchOpenIcon, "FolderInput");
export const FolderOpen = duotone(FolderOpenIcon, "FolderOpen");
export const FolderPlus = duotone(FolderSimplePlusIcon, "FolderPlus");
export const Forward = duotone(ArrowBendUpRightIcon, "Forward");
export const Globe = duotone(GlobeIcon, "Globe");
export const GripVertical = duotone(DotsSixVerticalIcon, "GripVertical");
export const HardDrive = duotone(HardDriveIcon, "HardDrive");
export const HelpCircle = duotone(QuestionIcon, "HelpCircle");
export const Image = duotone(ImageIcon, "Image");
export const ImageOff = duotone(ImageBrokenIcon, "ImageOff");
export const ImagePlus = duotone(ImageSquareIcon, "ImagePlus");
export const Inbox = duotone(TrayIcon, "Inbox");
export const Info = duotone(InfoIcon, "Info");
export const Italic = duotone(TextItalicIcon, "Italic");
export const Key = duotone(KeyIcon, "Key");
export const KeyRound = duotone(KeyIcon, "KeyRound");
export const Languages = duotone(TranslateIcon, "Languages");
export const LayoutGrid = duotone(SquaresFourIcon, "LayoutGrid");
export const Link2 = duotone(LinkSimpleIcon, "Link2");
export const List = duotone(ListBulletsIcon, "List");
export const ListChecks = duotone(ListChecksIcon, "ListChecks");
export const ListOrdered = duotone(ListNumbersIcon, "ListOrdered");
// Spinner ohne Duotone-Fläche: sonst dreht sich eine graue Scheibe statt eines Bogens.
export const Lock = duotone(LockIcon, "Lock");
export const LogOut = duotone(SignOutIcon, "LogOut");
export const Mail = duotone(EnvelopeSimpleIcon, "Mail");
export const MailCheck = duotone(EnvelopeOpenIcon, "MailCheck");
export const MailMinus = duotone(ProhibitIcon, "MailMinus");
export const MailOpen = duotone(EnvelopeSimpleOpenIcon, "MailOpen");
export const MapPin = duotone(MapPinIcon, "MapPin");
export const MessageSquare = duotone(ChatsIcon, "MessageSquare");
export const MessageSquareReply = duotone(ChatTeardropTextIcon, "MessageSquareReply");
export const Minus = duotone(MinusIcon, "Minus");
export const Monitor = duotone(MonitorIcon, "Monitor");
export const Moon = duotone(MoonIcon, "Moon");
export const MoreHorizontal = duotone(DotsThreeIcon, "MoreHorizontal");
export const Music = duotone(MusicNoteIcon, "Music");
export const Palette = duotone(PaletteIcon, "Palette");
export const PanelLeft = duotone(SidebarSimpleIcon, "PanelLeft");
export const PanelLeftClose = duotone(SidebarSimpleIcon, "PanelLeftClose");
export const PanelLeftOpen = duotone(SidebarSimpleIcon, "PanelLeftOpen");
export const PanelRight = duotone(SidebarSimpleIcon, "PanelRight", { mirrored: true });
export const Paperclip = duotone(PaperclipIcon, "Paperclip");
export const Pencil = duotone(PencilSimpleIcon, "Pencil");
export const Pin = duotone(PushPinIcon, "Pin");
export const PinOff = duotone(PushPinSlashIcon, "PinOff");
export const Plane = duotone(AirplaneTiltIcon, "Plane");
export const Plus = duotone(PlusIcon, "Plus");
export const Power = duotone(PowerIcon, "Power");
export const Printer = duotone(PrinterIcon, "Printer");
export const Quote = duotone(QuotesIcon, "Quote");
export const Redo = duotone(ArrowUUpRightIcon, "Redo");
export const RefreshCw = duotone(ArrowsClockwiseIcon, "RefreshCw");
export const RemoveFormatting = duotone(TextTSlashIcon, "RemoveFormatting");
export const Repeat = duotone(RepeatIcon, "Repeat");
export const Reply = duotone(ArrowBendUpLeftIcon, "Reply");
export const ReplyAll = duotone(ArrowBendDoubleUpLeftIcon, "ReplyAll");
export const RotateCcw = duotone(ArrowCounterClockwiseIcon, "RotateCcw");
export const Rss = duotone(RssIcon, "Rss");
export const Save = duotone(FloppyDiskIcon, "Save");
export const Scissors = duotone(ScissorsIcon, "Scissors");
export const SealCheck = duotone(SealCheckIcon, "SealCheck");
export const Search = duotone(MagnifyingGlassIcon, "Search");
export const Send = duotone(PaperPlaneTiltIcon, "Send");
export const Server = duotone(HardDrivesIcon, "Server");
export const Settings = duotone(GearSixIcon, "Settings");
export const Settings2 = duotone(SlidersHorizontalIcon, "Settings2");
export const Shield = duotone(ShieldIcon, "Shield");
export const ShieldAlert = duotone(ShieldWarningIcon, "ShieldAlert");
export const Sparkles = duotone(SparkleIcon, "Sparkles");
export const Sprout = duotone(PlantIcon, "Sprout");
export const Square = duotone(SquareIcon, "Square");
export const Star = duotone(StarIcon, "Star");
export const StarOff = duotone(StarIcon, "StarOff");
export const Strikethrough = duotone(TextStrikethroughIcon, "Strikethrough");
export const Sun = duotone(SunIcon, "Sun");
export const Tag = duotone(TagIcon, "Tag");
export const Tags = duotone(TagSimpleIcon, "Tags");
export const Trash2 = duotone(TrashIcon, "Trash2");
export const Type = duotone(TextTIcon, "Type");
export const Undo = duotone(ArrowUUpLeftIcon, "Undo");
export const Undo2 = duotone(ArrowUUpLeftIcon, "Undo2");
export const Unlink = duotone(LinkSimpleBreakIcon, "Unlink");
export const Upload = duotone(UploadSimpleIcon, "Upload");
export const User = duotone(UserIcon, "User");
export const UserCheck = duotone(UserCheckIcon, "UserCheck");
export const UserMinus = duotone(UserMinusIcon, "UserMinus");
export const Users = duotone(UsersIcon, "Users");
export const Video = duotone(VideoCameraIcon, "Video");
export const Volume2 = duotone(SpeakerHighIcon, "Volume2");
export const WifiOff = duotone(WifiSlashIcon, "WifiOff");
export const X = duotone(XIcon, "X");
export const XCircle = duotone(XCircleIcon, "XCircle");
