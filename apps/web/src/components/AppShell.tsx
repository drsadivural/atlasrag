import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Activity,
  Bell,
  Building2,
  ChevronDown,
  Database,
  FileBarChart,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Moon,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { Avatar, Badge, Button, DropdownMenu, Input, SkipLink, cn, type MenuItem } from '@uxe/ui';
import type { Permission } from '@uxe/contracts';
import { useSession } from '../lib/session.js';
import { useTheme } from '../lib/theme.js';
import { useI18n } from '../lib/i18n.js';
import { BrandLockup, BrandMark } from './Brand.js';

interface NavEntry {
  to: string;
  labelKey:
    | 'nav.dashboard'
    | 'nav.consult'
    | 'nav.knowledge'
    | 'nav.reports'
    | 'nav.activity'
    | 'nav.users'
    | 'nav.settings';
  icon: ReactNode;
  permission?: Permission;
  /** Shown in the mobile bottom bar; the rest live behind "More". */
  primaryMobile?: boolean;
}

const NAV: NavEntry[] = [
  {
    to: '/dashboard',
    labelKey: 'nav.dashboard',
    icon: <LayoutDashboard className="h-5 w-5" />,
    primaryMobile: true,
  },
  {
    to: '/consult',
    labelKey: 'nav.consult',
    icon: <MessageSquare className="h-5 w-5" />,
    permission: 'consultation:read',
    primaryMobile: true,
  },
  {
    to: '/knowledge',
    labelKey: 'nav.knowledge',
    icon: <Database className="h-5 w-5" />,
    permission: 'source:read',
    primaryMobile: true,
  },
  {
    to: '/reports',
    labelKey: 'nav.reports',
    icon: <FileBarChart className="h-5 w-5" />,
    permission: 'artifact:read',
    primaryMobile: true,
  },
  {
    to: '/activity',
    labelKey: 'nav.activity',
    icon: <Activity className="h-5 w-5" />,
    permission: 'audit:read',
  },
  {
    to: '/users',
    labelKey: 'nav.users',
    icon: <Users className="h-5 w-5" />,
    permission: 'member:read',
  },
  {
    to: '/settings/general',
    labelKey: 'nav.settings',
    icon: <Settings className="h-5 w-5" />,
    permission: 'settings:read',
  },
];

/**
 * The authenticated application shell.
 *
 * Desktop (>=1280px) keeps a persistent left rail. Tablet collapses it to an off-canvas
 * drawer. Mobile (<768px) drops it entirely in favour of a bottom bar carrying the four
 * primary destinations plus More, which is what the brief specifies.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { session, can } = useSession();
  const { t } = useI18n();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const visible = NAV.filter((entry) => !entry.permission || can(entry.permission));

  // Escape closes the drawer, matching every other dismissible surface in the app.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  if (!session) return null;

  return (
    <div className="flex min-h-dvh flex-col bg-[var(--uxe-bg)]">
      <SkipLink>{t('nav.skipToContent')}</SkipLink>

      <div className="flex min-h-dvh flex-1">
        {/* Persistent rail, desktop only. */}
        <aside
          className="hidden shrink-0 border-r border-[var(--uxe-border)] bg-[var(--uxe-surface)] xl:flex xl:flex-col"
          style={{ width: 'var(--uxe-nav-width)' }}
        >
          <SidebarContent entries={visible} />
        </aside>

        {/* Off-canvas drawer, tablet and below. */}
        {drawerOpen && (
          <div className="fixed inset-0 z-50 xl:hidden">
            <button
              type="button"
              aria-label={t('nav.closeMenu')}
              onClick={() => setDrawerOpen(false)}
              className="absolute inset-0 bg-[rgba(16,22,47,0.45)] backdrop-blur-[2px]"
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-label={t('nav.mainLabel')}
              className="absolute inset-y-0 left-0 flex w-[var(--uxe-nav-width)] flex-col border-r border-[var(--uxe-border)] bg-[var(--uxe-surface)] shadow-[var(--uxe-shadow-xl)]"
            >
              <div className="flex items-center justify-end p-2">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setDrawerOpen(false)}
                  aria-label={t('nav.closeMenu')}
                >
                  <X className="h-4 w-4" aria-hidden />
                </Button>
              </div>
              <SidebarContent entries={visible} onNavigate={() => setDrawerOpen(false)} />
            </div>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar onOpenMenu={() => setDrawerOpen(true)} />
          <main
            id="main"
            tabIndex={-1}
            className="min-w-0 flex-1 pb-[calc(var(--uxe-bottom-nav-height)+env(safe-area-inset-bottom,0px))] focus:outline-none md:pb-0"
          >
            {children}
          </main>
        </div>
      </div>

      <MobileNav entries={visible} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Sidebar                                                                    */
/* -------------------------------------------------------------------------- */

function SidebarContent({ entries, onNavigate }: { entries: NavEntry[]; onNavigate?: () => void }) {
  const { t } = useI18n();

  return (
    <>
      <div className="flex h-[var(--uxe-header-height)] items-center px-5">
        <NavLink
          to="/dashboard"
          className="rounded-[var(--uxe-radius-control)]"
          aria-label={t('app.name')}
        >
          <BrandLockup size="sm" />
        </NavLink>
      </div>

      <nav aria-label={t('nav.mainLabel')} className="flex-1 overflow-y-auto px-3 py-2">
        <p className="px-3 py-2 text-[11px] font-semibold tracking-wider text-[var(--uxe-text-tertiary)] uppercase">
          {t('nav.platform')}
        </p>
        <ul className="flex flex-col gap-0.5">
          {entries.map((entry) => (
            <li key={entry.to}>
              <NavLink
                to={entry.to}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-[var(--uxe-radius-control-lg)] px-3 py-2.5',
                    'text-[14px] font-medium transition-colors duration-[var(--uxe-duration-fast)]',
                    isActive
                      ? 'bg-[var(--uxe-surface-selected)] text-[var(--uxe-cobalt)]'
                      : 'text-[var(--uxe-text-secondary)] hover:bg-[var(--uxe-surface-hover)] hover:text-[var(--uxe-text)]',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      aria-hidden
                      className={cn(
                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--uxe-radius-control)]',
                        isActive
                          ? 'bg-[var(--uxe-cobalt)]/12 text-[var(--uxe-cobalt)]'
                          : 'text-[var(--uxe-text-tertiary)]',
                      )}
                    >
                      {entry.icon}
                    </span>
                    {t(entry.labelKey)}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <SourcesVerifiedCard />
    </>
  );
}

/** The reassurance card from the dashboard concept, pinned to the foot of the rail. */
function SourcesVerifiedCard() {
  const { t } = useI18n();
  return (
    <div className="m-3 rounded-[var(--uxe-radius-card)] border border-[var(--uxe-border)] bg-[var(--uxe-surface-sunken)] p-4">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="flex h-9 w-9 items-center justify-center rounded-[var(--uxe-radius-control)] bg-[var(--uxe-success-bg)] text-[var(--uxe-success)]"
        >
          <ShieldCheck className="h-5 w-5" />
        </span>
        <span className="text-[14px] font-semibold text-[var(--uxe-text)]">
          {t('compliance.sourcesVerified')}
        </span>
      </div>
      <p className="mt-2 text-[12px] leading-snug text-[var(--uxe-text-secondary)]">
        All answers are grounded in your approved sources.
      </p>
      <Button asChild variant="secondary" size="sm" full className="mt-3">
        <NavLink to="/knowledge">View sources</NavLink>
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Top bar                                                                    */
/* -------------------------------------------------------------------------- */

function TopBar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { session, signOut, switchWorkspace } = useSession();
  const { preference, setPreference, resolved } = useTheme();
  const { t } = useI18n();
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');

  // Cmd/Ctrl+K focuses global search, the shortcut users expect from every other tool.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!session) return null;

  const workspaceItems: MenuItem[] = session.workspaces.map((workspace) => ({
    label: workspace.name,
    icon: <Building2 className="h-4 w-4" aria-hidden />,
    onSelect: () => void switchWorkspace(workspace.id),
    disabled: workspace.id === session.workspace?.id,
    disabledReason: 'Current workspace',
  }));

  const profileItems: MenuItem[] = [
    {
      label: preference === 'dark' ? t('settings.themeLight') : t('settings.themeDark'),
      icon:
        resolved === 'dark' ? (
          <Sun className="h-4 w-4" aria-hidden />
        ) : (
          <Moon className="h-4 w-4" aria-hidden />
        ),
      onSelect: () => setPreference(resolved === 'dark' ? 'light' : 'dark'),
    },
    {
      label: t('nav.settings'),
      icon: <Settings className="h-4 w-4" aria-hidden />,
      onSelect: () => navigate('/settings/general'),
    },
    {
      label: t('auth.signOut'),
      icon: <LogOut className="h-4 w-4" aria-hidden />,
      onSelect: () => void signOut(),
      destructive: true,
      separatorBefore: true,
    },
  ];

  return (
    <header className="sticky top-0 z-30 flex h-[var(--uxe-header-height)] shrink-0 items-center gap-3 border-b border-[var(--uxe-border)] bg-[var(--uxe-surface)]/95 px-3 backdrop-blur sm:px-5">
      <Button
        variant="ghost"
        size="icon"
        className="xl:hidden"
        onClick={onOpenMenu}
        aria-label={t('nav.openMenu')}
      >
        <Menu className="h-5 w-5" aria-hidden />
      </Button>

      <NavLink to="/dashboard" className="xl:hidden" aria-label={t('app.name')}>
        <BrandMark size={34} />
      </NavLink>

      {session.workspace && (
        <DropdownMenu
          label={t('common.workspace')}
          trigger={
            <Button variant="secondary" size="md" className="hidden max-w-56 sm:inline-flex">
              <Building2
                className="h-4 w-4 shrink-0 text-[var(--uxe-text-secondary)]"
                aria-hidden
              />
              <span className="truncate">{session.workspace.name}</span>
              <ChevronDown
                className="h-4 w-4 shrink-0 text-[var(--uxe-text-secondary)]"
                aria-hidden
              />
            </Button>
          }
          items={workspaceItems}
        />
      )}

      <form
        role="search"
        className="mx-auto hidden w-full max-w-xl md:block"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim()) navigate(`/knowledge?q=${encodeURIComponent(query.trim())}`);
        }}
      >
        <label htmlFor="global-search" className="sr-only">
          {t('common.searchAll')}
        </label>
        <Input
          id="global-search"
          ref={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('common.searchAll')}
          iconLeft={<Search className="h-4 w-4" aria-hidden />}
          className="h-10 bg-[var(--uxe-surface-sunken)]"
        />
      </form>

      <div className="ml-auto flex items-center gap-2">
        <NavLink
          to="/activity"
          className="relative rounded-[var(--uxe-radius-control)] p-2 text-[var(--uxe-text-secondary)] hover:bg-[var(--uxe-surface-hover)]"
          aria-label={t('common.notifications')}
        >
          <Bell className="h-5 w-5" aria-hidden />
        </NavLink>

        <DropdownMenu
          label={t('common.profile')}
          items={profileItems}
          trigger={
            <button
              type="button"
              className="flex items-center gap-2.5 rounded-[var(--uxe-radius-control-lg)] border border-[var(--uxe-border)] bg-[var(--uxe-surface)] p-1 pr-2.5 transition-colors hover:bg-[var(--uxe-surface-hover)]"
            >
              <Avatar name={session.user.fullName} src={session.user.avatarUrl} size={30} />
              <span className="hidden min-w-0 text-left sm:block">
                <span className="block truncate text-[13px] leading-tight font-semibold text-[var(--uxe-text)]">
                  {session.user.fullName}
                </span>
                <span className="block truncate text-[11px] leading-tight text-[var(--uxe-text-secondary)]">
                  {session.user.title ?? roleLabel(session.workspace?.role)}
                </span>
              </span>
              <ChevronDown
                className="h-4 w-4 shrink-0 text-[var(--uxe-text-secondary)]"
                aria-hidden
              />
            </button>
          }
        />
      </div>
    </header>
  );
}

function roleLabel(role: string | undefined): string {
  if (!role) return '';
  return role.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/* -------------------------------------------------------------------------- */
/* Mobile bottom navigation                                                   */
/* -------------------------------------------------------------------------- */

function MobileNav({ entries }: { entries: NavEntry[] }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const primary = entries.filter((entry) => entry.primaryMobile).slice(0, 4);
  const overflow = entries.filter((entry) => !entry.primaryMobile);

  return (
    <nav
      // Its own name: two landmarks called "Main navigation" would be ambiguous wherever
      // both are exposed.
      aria-label={t('nav.mobileLabel')}
      className="pb-safe fixed inset-x-0 bottom-0 z-40 flex h-[calc(var(--uxe-bottom-nav-height)+env(safe-area-inset-bottom,0px))] items-start border-t border-[var(--uxe-border)] bg-[var(--uxe-surface)]/97 backdrop-blur md:hidden"
    >
      {primary.map((entry) => (
        <NavLink
          key={entry.to}
          to={entry.to}
          className={({ isActive }) =>
            cn(
              'flex h-[var(--uxe-bottom-nav-height)] flex-1 flex-col items-center justify-center gap-1',
              isActive ? 'text-[var(--uxe-cobalt)]' : 'text-[var(--uxe-text-secondary)]',
            )
          }
        >
          <span aria-hidden>{entry.icon}</span>
          <span className="text-[10px] leading-none font-medium">{t(entry.labelKey)}</span>
        </NavLink>
      ))}

      {overflow.length > 0 && (
        <DropdownMenu
          label={t('nav.more')}
          align="end"
          items={overflow.map((entry) => ({
            label: t(entry.labelKey),
            icon: entry.icon,
            onSelect: () => navigate(entry.to),
          }))}
          trigger={
            <button
              type="button"
              className="flex h-[var(--uxe-bottom-nav-height)] flex-1 flex-col items-center justify-center gap-1 text-[var(--uxe-text-secondary)]"
            >
              <MoreHorizontal className="h-5 w-5" aria-hidden />
              <span className="text-[10px] leading-none font-medium">{t('nav.more')}</span>
            </button>
          }
        />
      )}
    </nav>
  );
}

export { Badge };
