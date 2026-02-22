import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';

export default function ProfilePage() {
  const { user, logout, createInvite } = useAuthStore();
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const buildDate = Number.isNaN(Date.parse(__APP_BUILD_TIME__)) ? null : new Date(__APP_BUILD_TIME__);
  const buildLabel = buildDate
    ? buildDate.toLocaleString()
    : __APP_BUILD_TIME__;

  const handleCreateInvite = async () => {
    setIsCreating(true);
    try {
      const code = await createInvite();
      setInviteCode(code);
    } catch (error) {
      console.error('Failed to create invite:', error);
    } finally {
      setIsCreating(false);
    }
  };

  const copyToClipboard = () => {
    if (inviteCode) {
      navigator.clipboard.writeText(inviteCode);
    }
  };

  if (!user) return null;

  return (
    <div className="flex-1 flex flex-col p-4">
      <h1 className="text-xl font-bold text-white mb-6">Profile</h1>

      <div className="bg-slate-800/50 rounded-2xl p-6 mb-6">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-gradient-to-br from-primary-500 to-purple-600 flex items-center justify-center text-white font-bold text-2xl">
            {user.username[0].toUpperCase()}
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">{user.username}</h2>
            <p className="text-sm text-slate-400">Online</p>
          </div>
        </div>
      </div>

      {/* Invite Code Section */}
      <div className="bg-slate-800/50 rounded-2xl p-6 mb-6">
        <h3 className="text-sm font-medium text-slate-300 mb-3">Invite Friends</h3>
        
        {inviteCode ? (
          <div className="space-y-3">
            <div className="bg-slate-900 rounded-lg p-3 font-mono text-sm text-primary-400 break-all">
              {inviteCode}
            </div>
            <button
              onClick={copyToClipboard}
              className="w-full py-2 px-4 rounded-lg bg-slate-700 text-white text-sm hover:bg-slate-600 transition-colors"
            >
              Copy to Clipboard
            </button>
          </div>
        ) : (
          <button
            onClick={handleCreateInvite}
            disabled={isCreating}
            className="w-full py-2 px-4 rounded-lg bg-primary-600 text-white text-sm hover:bg-primary-500 transition-colors disabled:opacity-50"
          >
            {isCreating ? 'Creating...' : 'Generate Invite Code'}
          </button>
        )}
        <p className="text-xs text-slate-500 mt-3">
          Share this code with friends to let them join
        </p>
      </div>

      {/* Logout */}
      <div className="mt-auto mb-3 rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3">
        <p className="text-xs font-medium text-slate-300">Build</p>
        <p className="text-xs text-slate-400 mt-1 font-mono">
          v{__APP_VERSION__}{__APP_GIT_SHA__ ? ` (${__APP_GIT_SHA__})` : ''}
        </p>
        <p className="text-[11px] text-slate-500 mt-1">
          {buildLabel}
        </p>
      </div>

      <button
        onClick={logout}
        className="w-full py-3 px-4 rounded-xl bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
      >
        Sign Out
      </button>
    </div>
  );
}
