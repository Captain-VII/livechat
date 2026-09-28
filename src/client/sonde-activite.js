// --------------------------------------------------------------------------
// La sonde : un seul PowerShell qui tourne en continu et decrit, toutes les
// 2 secondes, ce qui se passe a l'ecran. Le C# n'est compile qu'une fois au
// lancement (relancer PowerShell + Add-Type a chaque sondage coutait une
// seconde de CPU toutes les 3 s, pendant une partie).
//
// Chaque ligne de sa sortie est un sondage JSON :
//   premier   le HWND au premier plan
//   d3d       plein ecran exclusif DirectX, vu par le shell
//   fenetres  les fenetres visibles : processus, exe, style, ecran principal ou
//             non, couvre-t-elle son ecran
//   sessions  les lectures annoncees a Windows (navigateurs, lecteurs, Store)
//   jeux      toutes les ~60 s : les exe reconnus comme jeux par la Game Bar
// --------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import readline from 'node:readline';

const SCRIPT_SONDE = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;

public class LiveChatFenetre {
  public long Hwnd { get; set; }
  public int Pid { get; set; }
  public string Exe { get; set; }
  public string Classe { get; set; }
  public int Style { get; set; }
  public bool Principal { get; set; }
  public bool Couvre { get; set; }
}

public static class LiveChatSonde {
  delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr param);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out int pid);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder nom, int taille);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int valeur, int taille);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint acces, bool herite, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder nom, ref int taille);
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int etat);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

  const uint GW_OWNER = 4;
  const int DWMWA_CLOAKED = 14;
  const uint MONITOR_DEFAULTTONEAREST = 2;
  const uint MONITORINFOF_PRIMARY = 1;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

  static Dictionary<int, string> exes = new Dictionary<int, string>();

  public static void OublierExes() { exes.Clear(); }

  // PROCESS_QUERY_LIMITED_INFORMATION passe meme pour la plupart des jeux
  // proteges par un anti-triche.
  static string ExeDe(int pid) {
    string exe;
    if (exes.TryGetValue(pid, out exe)) return exe;
    exe = "";
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h != IntPtr.Zero) {
      StringBuilder nom = new StringBuilder(1024);
      int taille = nom.Capacity;
      if (QueryFullProcessImageName(h, 0, nom, ref taille)) exe = nom.ToString();
      CloseHandle(h);
    }
    exes[pid] = exe;
    return exe;
  }

  // QUNS_RUNNING_D3D_FULL_SCREEN vaut 3 (2, c'est QUNS_BUSY, renvoye en continu).
  public static bool PleinEcranD3D() {
    int etat = 0;
    SHQueryUserNotificationState(out etat);
    return etat == 3;
  }

  public static long PremierPlan() { return GetForegroundWindow().ToInt64(); }

  // Les fenetres qu'on voit vraiment : visibles, pas reduites, sans
  // proprietaire (pas une boite de dialogue), avec un titre, et pas
  // "masquees" par le DWM (les applis du Store suspendues le sont).
  public static LiveChatFenetre[] Fenetres() {
    List<LiveChatFenetre> liste = new List<LiveChatFenetre>();
    EnumWindows(delegate (IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h) || IsIconic(h) || GetWindow(h, GW_OWNER) != IntPtr.Zero) return true;
      if (GetWindowTextLength(h) == 0) return true;
      int masquee;
      if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out masquee, 4) == 0 && masquee != 0) return true;
      RECT r;
      if (!GetWindowRect(h, out r) || r.Right <= r.Left || r.Bottom <= r.Top) return true;
      MONITORINFO mi = new MONITORINFO();
      mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      if (!GetMonitorInfo(MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST), ref mi)) return true;
      int pid;
      GetWindowThreadProcessId(h, out pid);
      StringBuilder classe = new StringBuilder(256);
      GetClassName(h, classe, classe.Capacity);
      LiveChatFenetre f = new LiveChatFenetre();
      f.Hwnd = h.ToInt64();
      f.Pid = pid;
      f.Exe = ExeDe(pid);
      f.Classe = classe.ToString();
      f.Style = GetWindowLong(h, -16);
      f.Principal = (mi.dwFlags & MONITORINFOF_PRIMARY) != 0;
      f.Couvre = r.Left <= mi.rcMonitor.Left && r.Top <= mi.rcMonitor.Top
        && r.Right >= mi.rcMonitor.Right && r.Bottom >= mi.rcMonitor.Bottom;
      liste.Add(f);
      return true;
    }, IntPtr.Zero);
    return liste.ToArray();
  }
}
'@

$parent = __PID_PARENT__

# Les lectures en cours : l'API des touches multimedia (WinRT). Si elle manque,
# on continue sans : les jeux restent detectes.
$gestionnaire = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
  } | Select-Object -First 1
  $type = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $tache = $asTask.MakeGenericMethod($type).Invoke($null, @($type::RequestAsync()))
  if ($tache.Wait(5000)) { $gestionnaire = $tache.Result }
} catch {
  [Console]::Error.WriteLine("Lectures multimedia indisponibles : $($_.Exception.Message)")
}

$tour = 0
while ($true) {
  # Electron plante ou est tue sans nous prevenir : on ne reste pas orphelin.
  if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { exit }

  $lectures = @()
  if ($gestionnaire) {
    try {
      foreach ($s in $gestionnaire.GetSessions()) {
        $infos = $s.GetPlaybackInfo()
        $lectures += @{
          app = [string]$s.SourceAppUserModelId
          statut = [string]$infos.PlaybackStatus
          type = [string]$infos.PlaybackType
        }
      }
    } catch {}
  }

  $sondage = @{}
  if ($tour % 30 -eq 0) {
    # Les PID se recyclent : on vide le cache de temps en temps.
    [LiveChatSonde]::OublierExes()
    $sondage.jeux = @(
      Get-ChildItem 'HKCU:\System\GameConfigStore\Children' -ErrorAction SilentlyContinue |
        ForEach-Object { (Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue).MatchedExeFullPath } |
        Where-Object { $_ }
    )
  }
  $sondage.premier = [LiveChatSonde]::PremierPlan()
  $sondage.d3d = [LiveChatSonde]::PleinEcranD3D()
  $sondage.fenetres = @([LiveChatSonde]::Fenetres())
  $sondage.sessions = @($lectures)
  $tour++

  try {
    [Console]::Out.WriteLine(($sondage | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
  } catch { exit }

  Start-Sleep -Milliseconds 2000
}
`.trim();

/** ConvertTo-Json rend un element seul sans tableau autour : on remet d'aplomb. */
function enListe(valeur) {
  if (valeur == null) return [];
  return Array.isArray(valeur) ? valeur : [valeur];
}

function normaliser(brut, jeux) {
  return {
    premier: Number(brut.premier),
    d3d: Boolean(brut.d3d),
    fenetres: enListe(brut.fenetres).map((f) => ({
      hwnd: Number(f.Hwnd),
      pid: f.Pid,
      exe: f.Exe ?? '',
      classe: f.Classe ?? '',
      style: f.Style | 0,
      principal: Boolean(f.Principal),
      couvre: Boolean(f.Couvre),
    })),
    sessions: enListe(brut.sessions),
    jeux,
  };
}

/**
 * @param {object} options
 * @param {(sondage: object) => void} options.surSondage
 * @returns {{ arreter: () => void }}
 */
export function demarrerSondeActivite({ surSondage }) {
  const script = SCRIPT_SONDE.replace('__PID_PARENT__', String(process.pid));
  // -EncodedCommand : aucun souci de guillemets ou de retours a la ligne.
  const encode = Buffer.from(script, 'utf16le').toString('base64');

  let processus = null;
  let arrete = false;
  let echecs = 0;
  let averti = false;
  /** @type {Set<string>} Chemins complets, en minuscules. */
  let jeuxConnus = new Set();

  function lancer() {
    processus = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let erreurs = '';
    processus.stderr.setEncoding('utf8');
    processus.stderr.on('data', (morceau) => {
      erreurs = (erreurs + morceau).slice(-2000);
    });

    readline.createInterface({ input: processus.stdout }).on('line', (ligne) => {
      let brut;
      try {
        brut = JSON.parse(ligne);
      } catch {
        return;
      }
      echecs = 0;
      if (brut.jeux !== undefined) {
        jeuxConnus = new Set(enListe(brut.jeux).map((chemin) => String(chemin).toLowerCase()));
      }
      surSondage(normaliser(brut, jeuxConnus));
    });

    processus.on('error', (erreur) => {
      console.warn('[livechat] Detection des jeux et films indisponible :', erreur.message);
    });

    processus.on('close', (code) => {
      processus = null;
      if (arrete) return;
      echecs += 1;
      if (!averti) {
        averti = true;
        const detail = erreurs.trim().split('\n').slice(-3).join(' ');
        console.warn(`[livechat] La sonde jeux/films s'est arretee (code ${code}). ${detail}`);
        console.warn('[livechat] Nouvelles tentatives en arriere-plan.');
      }
      const attente = Math.min(60000, 2000 * 2 ** Math.min(echecs, 5));
      setTimeout(() => {
        if (!arrete) lancer();
      }, attente).unref();
    });
  }

  lancer();

  return {
    arreter() {
      arrete = true;
      processus?.kill();
    },
  };
}
