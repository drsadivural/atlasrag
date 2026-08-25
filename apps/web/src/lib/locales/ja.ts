import type { en } from './en.js';

/**
 * A translation catalogue: the same keys as English, but free-form strings.
 *
 * `en` is declared `as const`, so its values are literal types. Typing this file against
 * those literals would demand that every Japanese string equal its English original, which
 * is obviously wrong — the key set is what must match, not the text.
 */
export type Catalogue = Partial<Record<keyof typeof en, string>>;

/**
 * Japanese catalogue.
 *
 * Typed as a partial of the English catalogue: keys that are not yet translated fall back
 * to English at runtime rather than rendering blank, and adding a key to `en` never breaks
 * this file. The structure is complete for the navigation, authentication and compliance
 * vocabulary — the terms a Japanese-speaking reviewer meets first — and the remainder
 * falls back until it is translated.
 */
export const ja: Catalogue = {
  'app.promise': '検証済みの回答。正確な根拠。修正済みの文書。',
  'app.consultantRole': 'コンプライアンス・コンサルタント',
  'app.consultantAlt': 'コンプライアンス・コンサルタントのあゆみ',

  'nav.dashboard': 'ダッシュボード',
  'nav.consult': '相談する',
  'nav.knowledge': 'ナレッジベース',
  'nav.reports': 'レポート',
  'nav.activity': 'アクティビティ',
  'nav.users': 'ユーザー',
  'nav.settings': '設定',
  'nav.more': 'その他',
  'nav.platform': 'プラットフォーム',
  'nav.skipToContent': 'メインコンテンツへスキップ',
  'nav.mainLabel': 'メインナビゲーション',
  'nav.mobileLabel': '主要ナビゲーション',

  'auth.welcomeBack': 'おかえりなさい',
  'auth.continueGoogle': 'Google で続行',
  'auth.continueMicrosoft': 'Microsoft で続行',
  'auth.or': 'または',
  'auth.workEmail': '会社のメールアドレス',
  'auth.password': 'パスワード',
  'auth.rememberMe': 'ログイン状態を保持する',
  'auth.forgotPassword': 'パスワードをお忘れですか？',
  'auth.signIn': 'サインイン',
  'auth.signOut': 'サインアウト',
  'auth.noAccount': 'アカウントをお持ちでない方',
  'auth.createAccount': 'アカウントを作成',
  'auth.enterpriseSecurity': 'エンタープライズ級のセキュリティ',
  'auth.enterpriseSecurityDetail': '文書は非公開のまま保護されます。',
  'auth.trustedBy': 'コンプライアンス部門に選ばれています',
  'auth.secureConfidential': '安全かつ機密',
  'auth.sessionExpired': 'セッションの有効期限が切れました。再度サインインしてください。',

  'compliance.compliant': '適合',
  'compliance.nonCompliant': '不適合',
  'compliance.needsEvidence': '根拠が必要',
  'compliance.notAssessed': '未評価',
  'compliance.partiallyCompliant': '部分的に適合',
  'compliance.unableToDetermine': '判断できません',
  'compliance.yes': 'はい',
  'compliance.no': 'いいえ',
  'compliance.sourcesVerified': '出典を検証済み',
  'compliance.groundedAnswer': '根拠に基づく回答',

  'consult.title': '今すぐ相談',
  'consult.newConsultation': '新しい相談',
  'consult.ask': '質問',
  'consult.summarize': '要約',
  'consult.checkCompliance': '適合性を確認',
  'consult.correctDocument': '文書を修正',
  'consult.answerStyle': '回答スタイル',
  'consult.styleYesNo': 'はい / いいえ',
  'consult.styleOptimal': '最適',
  'consult.styleDetails': '詳細と参照',
  'consult.evidenceCoverage': '根拠のカバレッジ',
  'consult.knowledgeOnly': 'ナレッジのみ',
  'consult.openExactPage': '該当ページを開く',

  'knowledge.title': 'ナレッジベース',
  'knowledge.subtitle': '根拠に基づく回答のための承認済みソース',
  'knowledge.ready': '準備完了',
  'knowledge.processing': '処理中',
  'knowledge.needsReview': '要確認',
  'knowledge.failed': '失敗',

  'common.search': '検索',
  'common.cancel': 'キャンセル',
  'common.edit': '編集',
  'common.delete': '削除',
  'common.save': '保存',
  'common.close': '閉じる',
  'common.retry': '再試行',
  'common.loading': '読み込み中',
};
