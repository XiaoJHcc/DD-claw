# 注册 DD-claw 的 Win32 AppUserModelID（AUMID），让 Windows Toast 通知
# 显示应用名「DD-claw」而不是借用的 Microsoft Store。
# 做法：在开始菜单创建带 System.AppUserModel.ID 属性的 .lnk + 通知设置注册表项。
# 幂等：重复执行覆盖同一路径。由 src/notify/aumid.ts 在首次弹通知前调用，也可手动执行。
param(
  [Parameter(Mandatory = $true)][string]$Target,   # 快捷方式目标（node.exe 路径）
  [Parameter(Mandatory = $true)][string]$LnkPath,  # .lnk 完整路径
  [string]$Arguments = '',                          # 目标参数（dist/index.js）
  [string]$WorkingDir = '',                         # 工作目录（项目根）
  [string]$Aumid = 'DD-claw'
)

$ErrorActionPreference = 'Stop'

# 1) 创建/覆盖 .lnk
$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($LnkPath)
$sc.TargetPath = $Target
if ($Arguments) { $sc.Arguments = $Arguments }
if ($WorkingDir) { $sc.WorkingDirectory = $WorkingDir }
$sc.Description = 'DD-claw 直播监听'
$sc.Save()

# 2) 给 .lnk 写 System.AppUserModel.ID 属性（需要 IPropertyStore COM interop）
$code = @'
using System;
using System.Runtime.InteropServices;

public static class AumidWriter
{
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PROPERTYKEY
    {
        public Guid fmtid;
        public uint pid;
        public PROPERTYKEY(Guid fmtid, uint pid) { this.fmtid = fmtid; this.pid = pid; }
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROPVARIANT
    {
        public ushort vt;
        public ushort r1, r2, r3;
        public IntPtr p;
        public IntPtr p2;
    }

    [ComImport, Guid("0000010b-0000-0000-C000-000000000046"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPersistFile
    {
        void GetClassID(out Guid pClassID);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName,
                  [MarshalAs(UnmanagedType.Bool)] bool fRemember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        void GetCount(out uint cProps);
        void GetAt(uint iProp, out PROPERTYKEY pkey);
        void GetValue([In] ref PROPERTYKEY key, [Out] IntPtr pv);
        void SetValue([In] ref PROPERTYKEY key, [In] ref PROPVARIANT pv);
        void Commit();
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046"), ClassInterface(ClassInterfaceType.None)]
    private class CShellLink { }

    public static void Set(string lnkPath, string appId)
    {
        object link = new CShellLink();
        IPersistFile file = (IPersistFile)link;
        // 必须 STGM_READWRITE(2)：只读(0) 打开时 SetValue/Commit 会 STG_E_ACCESSDENIED
        file.Load(lnkPath, 2);
        IPropertyStore store = (IPropertyStore)link;
        // PKEY_AppUserModel_ID = {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, pid 5
        PROPERTYKEY key = new PROPERTYKEY(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
        PROPVARIANT pv = new PROPVARIANT();
        pv.vt = 31; // VT_LPWSTR
        pv.p = Marshal.StringToCoTaskMemUni(appId);
        try
        {
            store.SetValue(ref key, ref pv);
            store.Commit();
        }
        finally
        {
            Marshal.FreeCoTaskMem(pv.p);
        }
        file.Save(lnkPath, true);
    }
}
'@

Add-Type -TypeDefinition $code -ReferencedAssemblies System
[AumidWriter]::Set($LnkPath, $Aumid)

# 3) 让通知进通知中心（Win10 对 Win32 AUMID 默认不留存）
$regPath = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\$Aumid"
try {
  New-Item -Path $regPath -Force | Out-Null
  New-ItemProperty -Path $regPath -Name 'ShowInActionCenter' -Value 1 -PropertyType DWord -Force | Out-Null
} catch {
  Write-Warning "注册表写入失败（不影响通知显示，只影响通知中心留存）: $_"
}

Write-Output "OK $Aumid -> $LnkPath"
