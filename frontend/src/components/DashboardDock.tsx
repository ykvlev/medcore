import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import './DashboardDock.css';

export interface DashboardDockAction {
  to: string;
  label: string;
  icon: LucideIcon;
}

/** Нижний «док» обзора: стеклянная капсула с быстрыми переходами и подписями при наведении. */
export function DashboardDock({ actions }: { actions: DashboardDockAction[] }) {
  if (!actions.length) return null;
  return (
    <nav className="dash-dock" aria-label="Быстрые действия">
      <div className="dash-dock-surface">
        {actions.map(action => {
          const Icon = action.icon;
          return (
            <Link key={action.to} to={action.to} className="dash-dock-link" aria-label={action.label}>
              <span className="dash-dock-icon"><Icon size={21} strokeWidth={1.65} aria-hidden="true" /></span>
              <span className="dash-dock-label" aria-hidden="true">{action.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
