import React, { useState } from 'react';
import { Lock, Mail, ArrowRight, Server } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import {
  getApiBaseUrl,
  getClientType,
  isNativeAndroid,
  resolveApiUrl,
  setApiBaseUrl,
  setStoredSession,
} from '../services/api';
import { getActiveCompanySettings } from '../utils/companySettings';
import type { CompanySettings, EmployeeUser } from '../types/erp';

interface LoginViewProps {
  onLoginSuccess: (user: EmployeeUser) => void;
  company?: CompanySettings;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLoginSuccess, company }) => {
  const { lang, setLang, t } = useI18n();
  const activeCompany = company || getActiveCompanySettings();
  const companyTitle = lang === 'bn' ? activeCompany.company_name_bn : activeCompany.company_name_en;
  const companyAddress = lang === 'bn' ? activeCompany.address_bn : activeCompany.address_en;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showServerBox, setShowServerBox] = useState(false);
  const [serverUrl, setServerUrl] = useState(() => getApiBaseUrl());

  const handleSaveServerUrl = () => {
    const saved = setApiBaseUrl(serverUrl);
    setServerUrl(saved);
    setShowServerBox(false);
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch(resolveApiUrl('/api/v1/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Type': getClientType() },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Authentication failed');
      }
      setStoredSession(data.token, data.user);
      onLoginSuccess(data.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col justify-center items-center px-3.5 py-6 sm:px-4 sm:py-12">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl sm:rounded-xl p-5 sm:p-8 shadow-sm">
        <div className="flex items-start justify-between gap-3 mb-6">
          <div className="flex items-center gap-3 min-w-0">
            {activeCompany.logo_data_url ? (
              <img
                src={activeCompany.logo_data_url}
                alt={companyTitle || 'Company Logo'}
                className="w-11 h-11 rounded-xl bg-white border border-slate-200 dark:border-slate-700 object-contain p-1 shrink-0"
              />
            ) : (
              <div className="w-11 h-11 rounded-xl bg-slate-900 dark:bg-amber-600 flex items-center justify-center text-amber-400 dark:text-white font-display font-bold text-base shrink-0">
                {activeCompany.short_code || 'SG'}
              </div>
            )}
            <div className="min-w-0">
              <h1 className="text-lg sm:text-xl font-display font-semibold text-slate-900 dark:text-white truncate">
                {companyTitle || t('app.brandFull')}
              </h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-1">
                {t('app.subtitle')}
              </p>
              {companyAddress && (
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 truncate">
                  {companyAddress}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {isNativeAndroid() && (
              <button
                type="button"
                onClick={() => setShowServerBox((v) => !v)}
                className="min-h-[34px] p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                title={lang === 'bn' ? 'সার্ভার সেটিংস' : 'Server URL'}
              >
                <Server className="w-3.5 h-3.5" />
              </button>
            )}
            <div
              className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-0.5 shrink-0"
              role="group"
              aria-label="Language"
            >
              <button
                type="button"
                onClick={() => setLang('en')}
                className={`min-h-[34px] px-2.5 py-1 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  lang === 'en'
                    ? 'bg-slate-900 text-white dark:bg-amber-600'
                    : 'text-slate-600 dark:text-slate-300'
                }`}
              >
                EN
              </button>
              <button
                type="button"
                onClick={() => setLang('bn')}
                className={`min-h-[34px] px-2.5 py-1 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  lang === 'bn'
                    ? 'bg-slate-900 text-white dark:bg-amber-600'
                    : 'text-slate-600 dark:text-slate-300'
                }`}
              >
                বাংলা
              </button>
            </div>
          </div>
        </div>

        {showServerBox && (
          <div className="mb-4 p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 space-y-2">
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              {lang === 'bn' ? 'সার্ভার ঠিকানা (Server URL)' : 'Server URL'}
            </label>
            <div className="flex gap-2">
              <input
                type="url"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://..."
                className="flex-1 min-h-[40px] px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
              <button
                type="button"
                onClick={handleSaveServerUrl}
                className="min-h-[40px] px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-semibold"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              {t('login.email')}
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full min-h-[46px] pl-10 pr-3 py-2.5 text-sm rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-600"
                placeholder="email@example.com"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              {t('login.password')}
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full min-h-[46px] pl-10 pr-3 py-2.5 text-sm rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-600"
              />
            </div>
          </div>

          {error && (
            <div className="p-3 rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/50 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full min-h-[48px] flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-slate-900 hover:bg-slate-800 dark:bg-amber-600 dark:hover:bg-amber-700 text-white text-sm font-semibold transition-colors disabled:opacity-60 active:scale-[0.99]"
          >
            <span>{loading ? t('login.signingIn') : t('login.signIn')}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
};
