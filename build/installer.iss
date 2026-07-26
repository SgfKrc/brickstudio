; BrickStudio Windows 安装包脚本(Inno Setup 6)
; 由 tools\win-build.mjs 在 electron-packager 之后调用;也可手动用 Inno Setup 打开编译。

#define MyAppName "BrickStudio"
#define MyAppDisplayName "BrickStudio 积木设计"
#define MyAppVersion "0.8.0"
#define MyAppExeName "BrickStudio.exe"
#define MySourceDir "..\release\BrickStudio-win32-x64"

[Setup]
AppId={{6F8B2C51-9D34-4A6B-B7E1-B21C57D10A08}}
AppName={#MyAppDisplayName}
AppVersion={#MyAppVersion}
AppPublisher=BrickStudio
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppDisplayName}
UninstallDisplayIcon={app}\{#MyAppExeName}
OutputDir=..\release
OutputBaseFilename=BrickStudio-Setup-{#MyAppVersion}
SetupIconFile=icon.ico
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"

[Files]
Source: "{#MySourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppDisplayName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 {#MyAppDisplayName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppDisplayName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "立即运行 {#MyAppDisplayName}"; Flags: nowait postinstall skipifsilent
