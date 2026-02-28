// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Description Generator Service
 *
 * アセットのdescriptionを自動生成するサービス
 *
 * 特徴:
 * - ルールベースの高速生成（外部API不使用）
 * - 日本語対応（検索用）
 * - 複数のソース（Lucide, Heroicons, SimpleIcons等）に対応
 * - スタイル・用途情報を含む
 */

import { isDevelopment } from '../utils';

// =============================================================================
// 型定義
// =============================================================================

/**
 * アセットメタデータ（description生成に必要な情報）
 */
export interface AssetMetadata {
  /** アセットの名前（例: "lucide-arrow-right"） */
  name: string;
  /** スタイル（line, filled, gradient, flat） */
  style?: string | null;
  /** 用途（icon, illustration, mascot, diagram, decoration） */
  purpose?: string | null;
  /** タグ配列 */
  tags: string[];
}

/**
 * Description生成オプション
 */
export interface DescriptionOptions {
  /** 最大文字数（デフォルト: 200） */
  maxLength?: number;
  /** ソース情報を含めるか（デフォルト: true） */
  includeSourceInfo?: boolean;
  /** 用途ヒントを含めるか（デフォルト: true） */
  includeUsageHint?: boolean;
}

/**
 * アイコン名の解析結果
 */
export interface ParsedIconName {
  /** ソース名（lucide, heroicons等） */
  source: string;
  /** キーワード配列 */
  keywords: string[];
  /** バリアント（regular, solid等） */
  variant?: string;
}

/**
 * Descriptionの構成要素
 */
export interface DescriptionParts {
  /** メインの説明 */
  mainDescription: string;
  /** スタイル情報 */
  styleInfo?: string;
  /** ソース情報 */
  sourceInfo?: string;
  /** 用途ヒント */
  usageHint?: string;
}

// =============================================================================
// 翻訳辞書
// =============================================================================

/** 英語から日本語への翻訳辞書 */
const KEYWORD_TRANSLATIONS: Record<string, string> = {
  // 基本オブジェクト
  arrow: '矢印',
  home: 'ホーム',
  house: 'ホーム',
  heart: 'ハート',
  star: 'スター',
  user: 'ユーザー',
  users: 'ユーザー',
  person: '人物',
  people: '人物',
  avatar: 'アバター',
  peep: '人物',

  // 方向
  up: '上向き',
  down: '下向き',
  left: '左向き',
  right: '右向き',
  forward: '前方',
  back: '後方',
  backward: '後方',

  // 形状
  circle: '円形',
  square: '四角形',
  triangle: '三角形',
  rectangle: '長方形',
  dot: 'ドット',
  line: 'ライン',

  // サイズ
  big: '大きい',
  small: '小さい',
  mini: 'ミニ',
  large: '大きい',
  medium: '中サイズ',

  // 操作・アクション
  search: '検索',
  settings: '設定',
  notification: '通知',
  notifications: '通知',
  bell: '通知',
  mail: 'メール',
  email: 'メール',
  message: 'メッセージ',
  messages: 'メッセージ',
  chat: 'チャット',
  comment: 'コメント',
  send: '送信',
  receive: '受信',
  download: 'ダウンロード',
  upload: 'アップロード',
  save: '保存',
  delete: '削除',
  remove: '削除',
  trash: 'ゴミ箱',
  edit: '編集',
  copy: 'コピー',
  paste: 'ペースト',
  cut: 'カット',
  add: '追加',
  plus: 'プラス',
  minus: 'マイナス',
  refresh: 'リフレッシュ',
  reload: 'リロード',
  sync: '同期',
  share: '共有',
  export: 'エクスポート',
  import: 'インポート',
  print: '印刷',
  printer: 'プリンター',
  play: '再生',
  pause: '一時停止',
  stop: '停止',
  record: '録音',
  mute: 'ミュート',
  volume: 'ボリューム',
  shuffle: 'シャッフル',
  repeat: 'リピート',
  skip: 'スキップ',
  rewind: '巻き戻し',
  fastforward: '早送り',
  sort: 'ソート',
  filter: 'フィルター',
  zoom: 'ズーム',
  x: '閉じる',
  close: '閉じる',
  cancel: 'キャンセル',
  confirm: '確認',
  check: 'チェック',
  checkmark: 'チェック',
  login: 'ログイン',
  log: 'ログ',
  logout: 'ログアウト',
  in: 'イン',
  out: 'アウト',

  // UI要素
  menu: 'メニュー',
  hamburger: 'ハンバーガー',
  navigation: 'ナビゲーション',
  sidebar: 'サイドバー',
  header: 'ヘッダー',
  footer: 'フッター',
  modal: 'モーダル',
  dialog: 'ダイアログ',
  popup: 'ポップアップ',
  dropdown: 'ドロップダウン',
  accordion: 'アコーディオン',
  tab: 'タブ',
  tabs: 'タブ',
  panel: 'パネル',
  card: 'カード',
  button: 'ボタン',
  input: '入力',
  form: 'フォーム',
  select: 'セレクト',
  option: 'オプション',
  radio: 'ラジオ',
  checkbox: 'チェックボックス',
  toggle: 'トグル',
  switch: 'スイッチ',
  slider: 'スライダー',
  sliders: 'スライダー',
  progress: 'プログレス',
  loading: 'ローディング',
  spinner: 'スピナー',
  tooltip: 'ツールチップ',
  alert: 'アラート',
  warning: '警告',
  error: 'エラー',
  success: '成功',
  info: '情報',
  help: 'ヘルプ',
  question: '質問',

  // メディア
  image: '画像',
  photo: '写真',
  picture: '画像',
  gallery: 'ギャラリー',
  video: 'ビデオ',
  camera: 'カメラ',
  film: 'フィルム',
  movie: '映画',
  music: '音楽',
  audio: 'オーディオ',
  sound: 'サウンド',
  mic: 'マイク',
  microphone: 'マイク',
  speaker: 'スピーカー',
  headphone: 'ヘッドフォン',
  headphones: 'ヘッドフォン',
  headset: 'ヘッドセット',

  // ファイル・ドキュメント
  file: 'ファイル',
  files: 'ファイル',
  folder: 'フォルダー',
  directory: 'ディレクトリ',
  document: 'ドキュメント',
  documents: 'ドキュメント',
  page: 'ページ',
  pages: 'ページ',
  book: 'ブック',
  bookmark: 'ブックマーク',
  archive: 'アーカイブ',
  attachment: '添付',
  paperclip: '添付',
  clipboard: 'クリップボード',
  note: 'ノート',
  notes: 'ノート',
  text: 'テキスト',
  type: 'テキスト',
  font: 'フォント',
  format: 'フォーマット',

  // 通信
  phone: '電話',
  call: '通話',
  telephone: '電話',
  mobile: 'モバイル',
  smartphone: 'スマートフォン',
  tablet: 'タブレット',
  laptop: 'ノートパソコン',
  desktop: 'デスクトップ',
  computer: 'コンピューター',
  monitor: 'モニター',
  screen: 'スクリーン',
  tv: 'テレビ',
  television: 'テレビ',
  wifi: 'Wi-Fi',
  bluetooth: 'Bluetooth',
  signal: '信号',
  antenna: 'アンテナ',
  broadcast: 'ブロードキャスト',
  rss: 'RSS',

  // ソーシャル・ブランド
  brand: 'ブランド',
  logo: 'ロゴ',
  social: 'ソーシャル',
  like: 'いいね',
  thumbs: 'サムズ',
  follow: 'フォロー',
  subscribe: '購読',

  // セキュリティ
  lock: 'ロック',
  unlock: 'ロック解除',
  key: '鍵',
  shield: 'シールド',
  security: 'セキュリティ',
  safe: 'セーフ',
  password: 'パスワード',
  fingerprint: '指紋',
  eye: '表示',
  hidden: '非表示',
  visible: '表示',
  invisible: '非表示',

  // 日時
  calendar: 'カレンダー',
  clock: '時計',
  time: '時間',
  timer: 'タイマー',
  stopwatch: 'ストップウォッチ',
  alarm: 'アラーム',
  schedule: 'スケジュール',
  event: 'イベント',
  date: '日付',
  day: '日',
  week: '週',
  month: '月',
  year: '年',

  // 天気・自然
  sun: '太陽',
  moon: '月',
  cloud: 'クラウド',
  rain: '雨',
  snow: '雪',
  weather: '天気',
  wind: '風',
  storm: '嵐',
  lightning: '稲妻',
  bolt: '稲妻',
  zap: '稲妻',
  thunder: '雷',
  umbrella: '傘',
  leaf: '葉',
  tree: '木',
  flower: '花',
  plant: '植物',
  water: '水',
  fire: '火',
  flame: '炎',

  // ビジネス
  chart: 'チャート',
  graph: 'グラフ',
  analytics: 'アナリティクス',
  statistics: '統計',
  trending: 'トレンド',
  increasing: '増加',
  decreasing: '減少',
  bar: 'バー',
  pie: 'パイ',
  report: 'レポート',
  presentation: 'プレゼンテーション',
  briefcase: 'ブリーフケース',
  building: 'ビルディング',
  office: 'オフィス',
  company: '会社',
  work: '仕事',
  job: '仕事',
  career: 'キャリア',
  money: 'お金',
  currency: '通貨',
  dollar: 'ドル',
  credit: 'クレジット',
  wallet: 'ウォレット',
  bank: '銀行',
  payment: '支払い',
  invoice: '請求書',
  receipt: 'レシート',
  cart: 'カート',
  shopping: 'ショッピング',
  bag: 'バッグ',
  basket: 'バスケット',
  gift: 'ギフト',
  box: 'ボックス',
  package: 'パッケージ',
  delivery: '配送',
  shipping: '配送',
  truck: 'トラック',
  car: '車',
  vehicle: '車両',

  // 開発・技術
  code: 'コード',
  coding: 'コーディング',
  programming: 'プログラミング',
  developer: '開発者',
  terminal: 'ターミナル',
  console: 'コンソール',
  command: 'コマンド',
  database: 'データベース',
  server: 'サーバー',
  api: 'API',
  bug: 'バグ',
  debug: 'デバッグ',
  git: 'Git',
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  repository: 'リポジトリ',
  repo: 'リポジトリ',
  branch: 'ブランチ',
  merge: 'マージ',
  commit: 'コミット',
  pull: 'プル',
  push: 'プッシュ',
  fork: 'フォーク',
  clone: 'クローン',
  binary: 'バイナリ',
  data: 'データ',
  storage: 'ストレージ',
  memory: 'メモリ',
  cpu: 'CPU',
  chip: 'チップ',
  circuit: '回路',
  usb: 'USB',
  ethernet: 'イーサネット',
  cable: 'ケーブル',
  plug: 'プラグ',
  power: '電源',
  battery: 'バッテリー',
  charging: '充電',
  energy: 'エネルギー',

  // レイアウト・配置
  layout: 'レイアウト',
  grid: 'グリッド',
  list: 'リスト',
  table: 'テーブル',
  row: '行',
  column: '列',
  cell: 'セル',
  align: '揃え',
  justify: '両端揃え',
  center: '中央',
  start: '開始',
  end: '終了',
  top: '上',
  bottom: '下',
  middle: '中央',
  vertical: '垂直',
  horizontal: '水平',
  space: 'スペース',
  gap: 'ギャップ',
  padding: 'パディング',
  margin: 'マージン',
  border: 'ボーダー',
  outline: 'アウトライン',
  shadow: 'シャドウ',
  layer: 'レイヤー',
  layers: 'レイヤー',
  stack: 'スタック',
  group: 'グループ',
  ungroup: 'グループ解除',

  // その他
  more: 'その他',
  less: '少なく',
  all: 'すべて',
  none: 'なし',
  empty: '空',
  full: '満杯',
  new: '新規',
  old: '古い',
  open: '開く',
  closed: '閉じた',
  expand: '展開',
  collapse: '折りたたみ',
  maximize: '最大化',
  minimize: '最小化',
  fullscreen: 'フルスクリーン',
  exit: '終了',
  enter: '入力',
  return: '戻る',
  next: '次へ',
  previous: '前へ',
  first: '最初',
  last: '最後',
  undo: '元に戻す',
  redo: 'やり直し',
  history: '履歴',
  recent: '最近',
  favorite: 'お気に入り',
  favorites: 'お気に入り',
  pin: 'ピン',
  unpin: 'ピン解除',
  flag: 'フラグ',
  priority: '優先度',
  important: '重要',
  link: 'リンク',
  unlink: 'リンク解除',
  chain: 'チェーン',
  anchor: 'アンカー',
  target: 'ターゲット',
  bullseye: '的',
  crosshair: '十字',
  cursor: 'カーソル',
  pointer: 'ポインター',
  hand: '手',
  touch: 'タッチ',
  gesture: 'ジェスチャー',
  drag: 'ドラッグ',
  drop: 'ドロップ',
  move: '移動',
  resize: 'リサイズ',
  rotate: '回転',
  flip: '反転',
  mirror: 'ミラー',
  transform: '変形',
  crop: 'クロップ',
  mask: 'マスク',
  effect: 'エフェクト',
  blend: 'ブレンド',
  opacity: '不透明度',
  brightness: '明るさ',
  contrast: 'コントラスト',
  saturation: '彩度',
  hue: '色相',
  temperature: '色温度',
  activity: 'アクティビティ',
  globe: 'グローブ',
  world: 'ワールド',
  earth: '地球',
  map: 'マップ',
  location: '位置',
  marker: 'マーカー',
  direction: '方向',
  directions: '方向',
  route: 'ルート',
  path: 'パス',
  turn: '曲がる',
  maps: 'マップ',
  compass: 'コンパス',
  navigate: 'ナビゲート',
  gps: 'GPS',
  inbox: '受信トレイ',
  outbox: '送信トレイ',
  sent: '送信済み',
  draft: '下書き',
  drafts: '下書き',
  coffee: 'コーヒー',
  rocket: 'ロケット',
  airplane: '飛行機',
  plane: '飛行機',
  ship: '船',
  boat: 'ボート',
  train: '電車',
  bus: 'バス',
  bicycle: '自転車',
  bike: '自転車',
  walk: '歩行',
  running: 'ランニング',
  run: '走る',
  fitness: 'フィットネス',
  gym: 'ジム',
  health: '健康',
  medical: '医療',
  hospital: '病院',
  doctor: '医者',
  pill: '薬',
  medicine: '薬',
  heartbeat: '心拍',
  pulse: 'パルス',
  dna: 'DNA',
  atom: '原子',
  molecule: '分子',
  science: '科学',
  lab: 'ラボ',
  experiment: '実験',
  test: 'テスト',
  flask: 'フラスコ',
  beaker: 'ビーカー',
  tool: 'ツール',
  tools: 'ツール',
  wrench: 'レンチ',
  hammer: 'ハンマー',
  screwdriver: 'ドライバー',
  scissors: 'はさみ',
  ruler: '定規',
  brush: 'ブラシ',
  pen: 'ペン',
  pencil: '鉛筆',
  eraser: '消しゴム',
  paint: 'ペイント',
  palette: 'パレット',
  color: 'カラー',
  colors: 'カラー',
  eyedropper: 'スポイト',
  pipette: 'ピペット',
  magnet: '磁石',
  puzzle: 'パズル',
  game: 'ゲーム',
  gaming: 'ゲーム',
  controller: 'コントローラー',
  joystick: 'ジョイスティック',
  dice: 'サイコロ',
  trophy: 'トロフィー',
  medal: 'メダル',
  award: 'アワード',
  badge: 'バッジ',
  certificate: '証明書',
  diploma: 'ディプロマ',
  graduation: '卒業',
  education: '教育',
  school: '学校',
  university: '大学',
  college: 'カレッジ',
  library: 'ライブラリ',
  reading: '読書',
  learning: '学習',
  knowledge: '知識',
  idea: 'アイデア',
  lightbulb: '電球',
  bulb: '電球',
  lamp: 'ランプ',
  light: 'ライト',
  dark: 'ダーク',
  theme: 'テーマ',
  mode: 'モード',
  invert: '反転',
  swatch: 'スウォッチ',
  fill: '塗りつぶし',
  stroke: 'ストローク',
  width: '幅',
  height: '高さ',
  size: 'サイズ',
  scale: 'スケール',
  aspect: 'アスペクト',
  ratio: '比率',
  proportion: '比率',
  paused: '一時停止中',
  translate: '翻訳',
  pants: 'パンツ',
  pockets: 'ポケット',
  number: '数字',
  png: 'PNG',
  jpg: 'JPG',
  jpeg: 'JPEG',
  svg: 'SVG',
  gif: 'GIF',
  pdf: 'PDF',
  doc: 'DOC',
  docx: 'DOCX',
  xls: 'XLS',
  xlsx: 'XLSX',
  ppt: 'PPT',
  pptx: 'PPTX',
  zip: 'ZIP',
  rar: 'RAR',
  tar: 'TAR',
  json: 'JSON',
  xml: 'XML',
  html: 'HTML',
  css: 'CSS',
  js: 'JavaScript',
  ts: 'TypeScript',
  py: 'Python',
  rb: 'Ruby',
  php: 'PHP',
  java: 'Java',
  go: 'Go',
  rust: 'Rust',
  swift: 'Swift',
  kotlin: 'Kotlin',
  dart: 'Dart',
  flutter: 'Flutter',
  react: 'React',
  vue: 'Vue',
  angular: 'Angular',
  svelte: 'Svelte',
  nuxt: 'Nuxt',
  gatsby: 'Gatsby',
  adobe: 'Adobe',
  illustrator: 'Illustrator',
  photoshop: 'Photoshop',
  figma: 'Figma',
  sketch: 'Sketch',
  xd: 'XD',
  canva: 'Canva',
  dribbble: 'Dribbble',
  behance: 'Behance',
  pinterest: 'Pinterest',
  instagram: 'Instagram',
  facebook: 'Facebook',
  twitter: 'Twitter',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  twitch: 'Twitch',
  discord: 'Discord',
  slack: 'Slack',
  teams: 'Teams',
  meet: 'Meet',
  skype: 'Skype',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  messenger: 'Messenger',
  wechat: 'WeChat',
  viber: 'Viber',
  snapchat: 'Snapchat',
  tiktok: 'TikTok',
  reddit: 'Reddit',
  hackernews: 'Hacker News',
  producthunt: 'Product Hunt',
  substack: 'Substack',
  wordpress: 'WordPress',
  ghost: 'Ghost',
  shopify: 'Shopify',
  amazon: 'Amazon',
  ebay: 'eBay',
  alibaba: 'Alibaba',
  apple: 'Apple',
  google: 'Google',
  microsoft: 'Microsoft',
  meta: 'Meta',
  netflix: 'Netflix',
  spotify: 'Spotify',
  deezer: 'Deezer',
  soundcloud: 'SoundCloud',
  bandcamp: 'Bandcamp',
  aws: 'AWS',
  azure: 'Azure',
  gcp: 'GCP',
  digitalocean: 'DigitalOcean',
  heroku: 'Heroku',
  vercel: 'Vercel',
  netlify: 'Netlify',
  cloudflare: 'Cloudflare',
  docker: 'Docker',
  kubernetes: 'Kubernetes',
  jenkins: 'Jenkins',
  travis: 'Travis',
  circleci: 'CircleCI',
  npm: 'npm',
  yarn: 'Yarn',
  pnpm: 'pnpm',
  webpack: 'Webpack',
  vite: 'Vite',
  rollup: 'Rollup',
  parcel: 'Parcel',
  esbuild: 'esbuild',
  babel: 'Babel',
  eslint: 'ESLint',
  prettier: 'Prettier',
  jest: 'Jest',
  vitest: 'Vitest',
  cypress: 'Cypress',
  playwright: 'Playwright',
  selenium: 'Selenium',
  storybook: 'Storybook',
  chromatic: 'Chromatic',
  ladle: 'Ladle',
  ionic: 'Ionic',
  honeybadger: 'Honeybadger',
  databricks: 'Databricks',
  gimp: 'GIMP',
  roku: 'Roku',
  wipro: 'Wipro',
  raspberrypi: 'Raspberry Pi',
  jquery: 'jQuery',
  citroen: 'Citroen',
  toshiba: 'Toshiba',
  refund: '返金',
  equals: 'イコール',
  long: '長い',
  chevron: 'シェブロン',
  castle: '城',
  barrel: '樽',
  illustration: 'イラスト',
  mascot: 'マスコット',
  diagram: 'ダイアグラム',
  decoration: '装飾',
  icon: 'アイコン',
};

/** ソース名の日本語表示 */
const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  lucide: 'Lucide',
  heroicons: 'Heroicons',
  simpleicons: 'Simple Icons',
  openpeeps: 'OpenPeeps',
  iconoir: 'Iconoir',
  tabler: 'Tabler Icons',
  bootstrap: 'Bootstrap Icons',
  phosphor: 'Phosphor Icons',
  feather: 'Feather Icons',
  remix: 'Remix Icon',
  ionicons: 'Ionicons',
};

/** スタイルの日本語表示 */
const STYLE_TRANSLATIONS: Record<string, string> = {
  line: 'line',
  filled: 'filled',
  flat: 'flat',
  gradient: 'グラデーション',
  outline: 'outline',
  solid: 'solid',
};

/** 用途の日本語表示 */
const PURPOSE_TRANSLATIONS: Record<string, string> = {
  icon: 'アイコン',
  illustration: 'イラスト',
  mascot: 'マスコット',
  diagram: 'ダイアグラム',
  decoration: '装飾',
  other: 'その他',
};

/** 用途別の使用ヒント */
const PURPOSE_USAGE_HINTS: Record<string, string> = {
  icon: 'UIやナビゲーションに使用',
  illustration: 'コンテンツの装飾やストーリーテリングに使用',
  mascot: 'ブランディングやキャラクターとして使用',
  diagram: '説明図やフローチャートに使用',
  decoration: 'ページの装飾要素として使用',
};

// =============================================================================
// ユーティリティ関数
// =============================================================================

/**
 * 開発環境かどうかを判定
 */
function isDevEnvironment(): boolean {
  if (typeof isDevelopment === 'function') {
    return isDevelopment();
  }
  return process.env.NODE_ENV === 'development';
}

// =============================================================================
// メイン関数
// =============================================================================

/**
 * アイコン名を解析してソース、キーワード、バリアントを抽出
 *
 * @param name アイコン名（例: "lucide-arrow-big-right"）
 * @returns 解析結果
 */
export function parseIconName(name: string): ParsedIconName {
  const parts = name.split('-');
  const source = parts[0] || name;
  let keywords: string[] = [];
  let variant: string | undefined;

  if (parts.length > 1) {
    // iconoirの場合、2番目の要素がvariant（regular/solid）かチェック
    if (source === 'iconoir' && (parts[1] === 'regular' || parts[1] === 'solid')) {
      variant = parts[1];
      keywords = parts.slice(2);
    }
    // openpeepsの場合、peepの後は数字なのでpeepのみをキーワードとする
    else if (source === 'openpeeps') {
      keywords = parts[1] === 'peep' ? ['peep'] : parts.slice(1);
    }
    // 通常ケース
    else {
      keywords = parts.slice(1);
    }
  }

  const result: ParsedIconName = { source, keywords };
  if (variant !== undefined) {
    result.variant = variant;
  }
  return result;
}

/**
 * 英語キーワードを日本語に変換
 *
 * @param keyword 英語キーワード
 * @returns 日本語変換結果（辞書にない場合はそのまま返す）
 */
export function translateToJapanese(keyword: string): string {
  const normalized = keyword.toLowerCase();
  return KEYWORD_TRANSLATIONS[normalized] || keyword;
}

/**
 * キーワード配列を日本語に変換して結合
 *
 * @param keywords キーワード配列
 * @returns 日本語に変換されたキーワード配列
 */
function translateKeywords(keywords: string[]): string[] {
  // 数字のみのキーワードは除外（openpeepsのID部分など）
  const filtered = keywords.filter(k => !/^\d+$/.test(k));
  return filtered.map(k => translateToJapanese(k));
}

/**
 * ソース固有の説明を生成
 *
 * @param source ソース名
 * @param keywords キーワード配列
 * @param purpose 用途
 * @returns ソース固有の説明
 */
function generateSourceSpecificDescription(source: string, keywords: string[], purpose?: string | null): string {
  const translatedKeywords = translateKeywords(keywords);

  switch (source) {
    case 'simpleicons': {
      // ブランドアイコンの場合
      const firstKeyword = keywords[0];
      if (firstKeyword) {
        // ブランド名の最初の文字を大文字にする
        const brandName = firstKeyword.charAt(0).toUpperCase() + firstKeyword.slice(1);
        // 辞書に変換がある場合はそれを使用
        const translated = KEYWORD_TRANSLATIONS[firstKeyword.toLowerCase()];
        return `${translated || brandName}のロゴ`;
      }
      return 'ブランドロゴ';
    }

    case 'openpeeps':
      return '人物イラスト';

    default: {
      // 用途に応じた説明
      const purposeStr = purpose ? PURPOSE_TRANSLATIONS[purpose] || purpose : 'アイコン';

      // 通常のアイコン
      if (translatedKeywords.length > 0) {
        // 重複を除去して結合
        const uniqueKeywords = [...new Set(translatedKeywords)];
        return uniqueKeywords.join('の') + purposeStr;
      }
      return purposeStr;
    }
  }
}

/**
 * Description構成要素を構築
 *
 * @param metadata アセットメタデータ
 * @returns Description構成要素
 */
export function buildDescriptionParts(metadata: AssetMetadata): DescriptionParts {
  const { name, style, purpose } = metadata;
  const parsed = parseIconName(name);

  // メイン説明を生成
  const mainDescription = generateSourceSpecificDescription(parsed.source, parsed.keywords, purpose);

  // スタイル情報
  let styleInfo: string | undefined;
  if (parsed.source === 'openpeeps') {
    styleInfo = '手描き風イラスト';
  } else if (parsed.variant) {
    styleInfo = `${parsed.variant}スタイル`;
  } else if (style) {
    styleInfo = STYLE_TRANSLATIONS[style] ? `${STYLE_TRANSLATIONS[style]}スタイル` : `${style}スタイル`;
  }

  // ソース情報
  const sourceDisplayName = SOURCE_DISPLAY_NAMES[parsed.source] || parsed.source;
  const sourceInfo = `${sourceDisplayName}アイコンセット`;

  // 用途ヒント
  let usageHint: string | undefined;
  if (parsed.source === 'simpleicons') {
    usageHint = 'ブランド表示やソーシャルリンクに使用';
  } else if (purpose) {
    usageHint = PURPOSE_USAGE_HINTS[purpose];
  }

  const result: DescriptionParts = {
    mainDescription,
    sourceInfo,
  };
  if (styleInfo) {
    result.styleInfo = styleInfo;
  }
  if (usageHint) {
    result.usageHint = usageHint;
  }
  return result;
}

/**
 * アセットメタデータからdescriptionを自動生成
 *
 * @param metadata アセットメタデータ
 * @param options 生成オプション
 * @returns 生成されたdescription
 */
export function generateDescription(
  metadata: AssetMetadata,
  options: DescriptionOptions = {}
): string {
  const {
    maxLength = 200,
    includeSourceInfo = true,
    includeUsageHint = true,
  } = options;

  if (isDevEnvironment()) {
    // eslint-disable-next-line no-console -- Intentional debug log in development
    console.log('[DescriptionGenerator] Generating for:', metadata.name);
  }

  const parts = buildDescriptionParts(metadata);
  const sentences: string[] = [];

  // メイン説明
  sentences.push(parts.mainDescription);

  // スタイル情報
  if (parts.styleInfo) {
    sentences.push(parts.styleInfo);
  }

  // ソース情報
  if (includeSourceInfo && parts.sourceInfo) {
    sentences.push(parts.sourceInfo);
  }

  // 用途ヒント
  if (includeUsageHint && parts.usageHint) {
    sentences.push(parts.usageHint);
  }

  // タグからの追加情報
  const parsed = parseIconName(metadata.name);
  const sentenceText = sentences.join('');
  const relevantTags = metadata.tags
    .filter(t => !parsed.keywords.includes(t) && t !== parsed.source)
    .slice(0, 3)
    .map(t => {
      const translated = translateToJapanese(t);
      // 翻訳が行われた場合（元と異なる場合）のみ返す
      return translated !== t ? translated : null;
    })
    .filter((t): t is string => t !== null && !sentenceText.includes(t))
    .slice(0, 2);

  if (relevantTags.length > 0) {
    sentences.push(`関連: ${relevantTags.join('、')}`);
  }

  // 結合
  let description = sentences.join('。');
  if (!description.endsWith('。')) {
    description += '。';
  }

  // 長さ制限
  if (description.length > maxLength) {
    // maxLengthより短くなるように切り詰め、末尾に...を追加
    const truncated = description.substring(0, maxLength - 3);
    // 最後の句点を見つけて、そこで切る
    const lastPeriod = truncated.lastIndexOf('。');
    if (lastPeriod > 0 && lastPeriod > maxLength - 20) {
      description = truncated.substring(0, lastPeriod + 1);
    } else {
      description = truncated + '...';
    }
  }

  if (isDevEnvironment()) {
    // eslint-disable-next-line no-console -- Intentional debug log in development
    console.log('[DescriptionGenerator] Generated:', description);
  }

  return description;
}

// =============================================================================
// デフォルトエクスポート
// =============================================================================

export default {
  generateDescription,
  parseIconName,
  translateToJapanese,
  buildDescriptionParts,
};
