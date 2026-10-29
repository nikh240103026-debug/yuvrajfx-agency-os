import express, { type Express } from 'express';
import helmet from 'helmet';
import type { AppContext } from './context.ts';
import { csrfGuard, requireAdmin, requireClient, requireStaff, sessionMiddleware } from './lib/auth.ts';
import { errorHandler, HttpError } from './lib/http.ts';
import { authRouter } from './routes/auth.ts';
import { clientsRouter } from './routes/clients.ts';
import { teamRouter } from './routes/team.ts';
import { deliverablesRouter, feedbackRouter, projectsRouter } from './routes/projects.ts';
import { invoicesRouter, paymentsRouter } from './routes/invoices.ts';
import { expensesRouter } from './routes/expenses.ts';
import { financeRouter } from './routes/finance.ts';
import { leadsRouter } from './routes/leads.ts';
import { recurringRouter, tasksRouter } from './routes/tasks.ts';
import { automationsRouter, outboxRouter } from './routes/automations.ts';
import { settingsRouter } from './routes/settings.ts';
import { portalRouter } from './routes/portal.ts';
import { activityRouter, calendarRouter, dashboardRouter, notificationsRouter, searchRouter } from './routes/workspace.ts';

/** The API. Static files / the Vite dev server are mounted by index.ts after this. */
export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.set('query parser', 'simple');

  app.use(
    helmet({
      contentSecurityPolicy: ctx.config.isDev
        ? false
        : {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:', 'blob:'],
              fontSrc: ["'self'", 'data:'],
              connectSrc: ["'self'"],
              frameAncestors: ["'none'"],
              formAction: ["'self'"],
              objectSrc: ["'none'"],
              baseUri: ["'self'"],
              upgradeInsecureRequests: null,
            },
          },
      crossOriginEmbedderPolicy: false,
      hsts: ctx.config.cookieSecure,
    }),
  );

  app.use('/api', express.json({ limit: '5mb' }));
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', sessionMiddleware(ctx));
  app.use('/api', csrfGuard);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: ctx.nowIso() });
  });

  app.use('/api/auth', authRouter(ctx));
  app.use('/api/portal', requireClient, portalRouter(ctx));

  // Staff (owner, admin, team member)
  app.use('/api/dashboard', requireStaff, dashboardRouter(ctx));
  app.use('/api/clients', requireStaff, clientsRouter(ctx));
  app.use('/api/team', requireStaff, teamRouter(ctx));
  app.use('/api/projects', requireStaff, projectsRouter(ctx));
  app.use('/api/deliverables', requireStaff, deliverablesRouter(ctx));
  app.use('/api/feedback', requireStaff, feedbackRouter(ctx));
  app.use('/api/tasks', requireStaff, tasksRouter(ctx));
  app.use('/api/recurring', requireStaff, recurringRouter(ctx));
  app.use('/api/calendar', requireStaff, calendarRouter(ctx));
  app.use('/api/notifications', requireStaff, notificationsRouter(ctx));
  app.use('/api/activity', requireStaff, activityRouter(ctx));
  app.use('/api/search', requireStaff, searchRouter(ctx));

  // Owner/admin only: money, sales, automation, settings
  app.use('/api/invoices', requireAdmin, invoicesRouter(ctx));
  app.use('/api/payments', requireAdmin, paymentsRouter(ctx));
  app.use('/api/expenses', requireAdmin, expensesRouter(ctx));
  app.use('/api/finance', requireAdmin, financeRouter(ctx));
  app.use('/api/leads', requireAdmin, leadsRouter(ctx));
  app.use('/api/automations', requireAdmin, automationsRouter(ctx));
  app.use('/api/outbox', requireAdmin, outboxRouter(ctx));
  app.use('/api/settings', requireAdmin, settingsRouter(ctx));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Unknown API endpoint.')));
  app.use('/api', errorHandler);
  return app;
}
