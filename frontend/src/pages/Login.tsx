import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { motion } from 'motion/react';
import { ArrowRight, Database, Eye, EyeOff, HeartPulse, LoaderCircle, LockKeyhole, ShieldCheck, Users } from 'lucide-react';
import { useAuth } from '../auth';
import { errorMessage } from '../api';
import { Scene } from '../components/Layout';
import { Button, Loading } from '../components/ui';

const schema = z.object({ login: z.string().trim().min(1, 'Введите логин'), password: z.string().min(1, 'Введите пароль') });
type LoginValues = z.infer<typeof schema>;
export function LoginPage() {
  const { user, isPending, login } = useAuth();
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const form = useForm<LoginValues>({ resolver: zodResolver(schema), defaultValues: { login: '', password: '' } });
  if (isPending) return <div className="connection-screen"><Loading label="Открываем MEDCORE" /></div>;
  if (user) return <Navigate to="/dashboard" replace />;
  async function submit(values: LoginValues) {
    setError('');
    try {
      await login(values);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from?.startsWith('/') && !from.startsWith('//') && from !== '/login' ? from : '/dashboard', { replace: true });
    } catch (error) { setError(errorMessage(error)); }
  }
  return <div className="login-page"><Scene /><header className="login-header"><a className="login-brand" href="/login"><span className="brand-mark"><HeartPulse size={26} /></span>MED<span>CORE</span></a><span className="login-edition">Медицинская информационная система</span></header><main className="login-main"><motion.div className="login-intro" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}><div className="eyebrow"><span className="status-dot" /> Единое рабочее пространство</div><h1>Забота о данных.<br /><span>Внимание к людям.</span></h1><p>Пациенты, медицинские организации и история лечения — в одной системе с доступом по вашей роли.</p><div className="login-features"><span><Database size={17} /> Единая история</span><span><Users size={17} /> Работа команды</span><span><ShieldCheck size={17} /> Разделение доступа</span></div><div className="login-art" aria-hidden="true"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-cross"><HeartPulse size={67} strokeWidth={1.1} /></div><span className="art-point point-one" /><span className="art-point point-two" /><span className="art-point point-three" /></div></motion.div><motion.section className="login-card glass-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, delay: 0.1 }}><div className="login-card-icon"><LockKeyhole size={23} strokeWidth={1.5} /></div><h2>Вход в MEDCORE</h2><p>Войдите в своё рабочее пространство</p><form onSubmit={form.handleSubmit(submit)} noValidate><div className="field"><label htmlFor="login">Логин</label><input id="login" autoComplete="username" placeholder="Введите логин" autoFocus {...form.register('login')} aria-invalid={!!form.formState.errors.login} aria-describedby={form.formState.errors.login ? 'login-error' : undefined} />{form.formState.errors.login && <span className="field-error" id="login-error">{form.formState.errors.login.message}</span>}</div><div className="field"><label htmlFor="password">Пароль</label><div className="input-with-action"><input id="password" type={visible ? 'text' : 'password'} autoComplete="current-password" placeholder="Введите пароль" {...form.register('password')} aria-invalid={!!form.formState.errors.password} aria-describedby={form.formState.errors.password ? 'password-error' : undefined} /><button type="button" className="input-action" onClick={() => setVisible(previous => !previous)} aria-label={visible ? 'Скрыть пароль' : 'Показать пароль'}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>{form.formState.errors.password && <span className="field-error" id="password-error">{form.formState.errors.password.message}</span>}</div>{error && <div className="form-error" role="alert">{error}</div>}<Button type="submit" className="login-submit" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting ? <><LoaderCircle size={18} className="spin" />Входим…</> : <>Войти в систему<ArrowRight size={18} /></>}</Button></form><div className="login-note"><ShieldCheck size={15} /><span>Возможности определяются вашей ролью</span></div></motion.section></main><footer className="login-footer"><span>MEDCORE</span><span>Учебный проект · Только вымышленные данные</span></footer></div>;
}
