#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <windows.h>
// WIN32_LEAN_AND_MEAN 之后 windows.h 不再带 COM 的头，而快捷方式要用 IShellLink
#include <objbase.h>
#include <shellapi.h>
#include <shlguid.h>
#include <shlobj.h>
#include <winhttp.h>
#include <winreg.h>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cwctype>
#include <iostream>
#include <iterator>
#include <memory>
#include <optional>
#include <regex>
#include <string>
#include <vector>

namespace {

constexpr int kMinNodeMajor = 22;
constexpr int kMinNodeMinor = 18;
constexpr DWORD kWin10Build = 10240;
constexpr DWORD kWin11Build = 22000;

constexpr const char* kInstallerVersion = "1.2.0";
constexpr const wchar_t* kNpmPackage = L"ehbrowser@latest";
constexpr const wchar_t* kNodeDownloadPage = L"https://nodejs.org/";

/** 隐藏启动器在安装器里的资源名（见 installer.rc.in），装完后释放到 npm 全局目录 */
constexpr const wchar_t* kLauncherResource = L"EHBROWSER_LAUNCHER";
constexpr const wchar_t* kLauncherFileName = L"ehbrowser-launcher.exe";
/** 快捷方式的名字（桌面与开始菜单各一个） */
constexpr const wchar_t* kShortcutName = L"EhBrowser.lnk";
/** 快捷方式的参数：交给 cmd 按 PATH 解析，换 Node 版本、npm 全局目录变了也不容易断 */
constexpr const wchar_t* kShortcutArguments = L"ehbrowser";

constexpr int kExitOk = 0;
constexpr int kExitBadArgs = 1;
constexpr int kExitUnsupportedOs = 2;
constexpr int kExitCancelled = 3;
constexpr int kExitNodeFailed = 4;
constexpr int kExitEhBrowserFailed = 5;

struct Options {
    bool assumeYes = false;
    bool dryRun = false;
    bool checkOnly = false;
    bool help = false;
    bool elevatedRetry = false;
    // 快捷方式：createShortcutsSet 为假时表示「没在命令行里说」，装完要问一次
    bool createShortcuts = false;
    bool createShortcutsSet = false;
    std::wstring nodeDir;
    bool nodeDirSet = false;
};

void PrintHelp() {
    std::cout <<
        "EhBrowser 安装器 " << kInstallerVersion << "（Windows 命令行版）\n"
        "\n"
        "用法：ehbrowser-installer.exe [选项]\n"
        "\n"
        "选项：\n"
        "  -y, --yes             全部问题取默认值，不询问（无人值守用）\n"
        "      --node-dir <路径>  Node.js 需要安装时用这个目录，不问\n"
        "      --shortcuts       创建桌面与开始菜单快捷方式，不问\n"
        "      --no-shortcuts    不创建快捷方式，不问\n"
        "      --dry-run         只打印将要执行的命令，不下载也不安装\n"
        "      --check           只检查系统版本与 Node.js，不做任何修改\n"
        "  -h, --help            显示本帮助\n"
        "\n"
        "流程：\n"
        "  1) 系统版本低于 Windows 10 -> 判定不支持并退出\n"
        "  2) 未检测到 Node.js >= 22 -> 询问是否安装、装到哪个目录\n"
        "  3) 执行 npm install -g ehbrowser@latest\n"
        "  4) 询问是否创建桌面与开始菜单快捷方式（默认创建）\n"
        "\n"
        "快捷方式指向一个没有控制台窗口的启动器（ehbrowser-launcher.exe）：它把客户端\n"
        "隐藏启动，并在通知区域放一个托盘图标——右键可打开浏览器、查看日志、重启或\n"
        "关闭客户端；再双击一次快捷方式只是把界面调出来，不会起第二个客户端。\n"
        "客户端的控制台输出收在 %LOCALAPPDATA%\\ehbrowser\\launcher.log，启动失败时\n"
        "会用消息框把日志尾巴提示出来。\n"
        "\n"
        "退出码：0 成功，1 参数错误，2 系统版本不支持，3 用户取消，\n"
        "        4 Node.js 安装失败，5 ehbrowser 安装失败\n";
}

bool ParseArgs(int argc, wchar_t** argv, Options& o, std::wstring& err) {
    auto needValue = [&](int& i, std::wstring& out) {
        if (i + 1 >= argc) return false;
        out = argv[++i];
        return true;
    };

    for (int i = 1; i < argc; ++i) {
        std::wstring a = argv[i];

        if (a == L"-h" || a == L"--help") {
            o.help = true;
        } else if (a == L"-y" || a == L"--yes") {
            o.assumeYes = true;
        } else if (a == L"--shortcuts") {
            o.createShortcuts = true;
            o.createShortcutsSet = true;
        } else if (a == L"--no-shortcuts") {
            o.createShortcuts = false;
            o.createShortcutsSet = true;
        } else if (a == L"--dry-run") {
            o.dryRun = true;
        } else if (a == L"--check") {
            o.checkOnly = true;
        } else if (a == L"--elevated-retry") {
            o.elevatedRetry = true;
        } else if (a == L"--node-dir") {
            if (!needValue(i, o.nodeDir)) {
                err = L"--node-dir 后面缺少路径";
                return false;
            }
            o.nodeDirSet = true;
        } else if (a.rfind(L"--node-dir=", 0) == 0) {
            o.nodeDir = a.substr(11);
            o.nodeDirSet = true;
        } else {
            err = L"无法识别的参数：" + a;
            return false;
        }
    }
    return true;
}

void SetupConsole() {

    SetConsoleOutputCP(CP_UTF8);
    SetConsoleCP(CP_UTF8);
    SetConsoleTitleW(L"EhBrowser 安装器");
}

std::string ToUtf8(const std::wstring& w) {
    if (w.empty()) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
    if (n <= 0) return {};
    std::string s(static_cast<size_t>(n), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
    return s;
}

std::wstring ToWide(const std::string& s) {
    if (s.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
    if (n <= 0) return {};
    std::wstring w(static_cast<size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), w.data(), n);
    return w;
}

void Say(const std::string& s) { std::cout << s << std::flush; }
void SayLine(const std::string& s = {}) { std::cout << s << "\n" << std::flush; }
void SayPath(const char* label, const std::wstring& p) { SayLine(std::string(label) + ToUtf8(p)); }
void Warn(const std::string& s) { SayLine("警告：" + s); }
void Fail(const std::string& s) { SayLine("错误：" + s); }

std::string FormatMessageFrom(DWORD err, HMODULE module) {
    LPWSTR buf = nullptr;
    DWORD flags = FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_IGNORE_INSERTS |
                  (module ? FORMAT_MESSAGE_FROM_HMODULE : FORMAT_MESSAGE_FROM_SYSTEM);
    DWORD n = FormatMessageW(flags, module, err, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
                             reinterpret_cast<LPWSTR>(&buf), 0, nullptr);
    if (!n || !buf) return {};
    std::wstring w(buf, n);
    LocalFree(buf);
    while (!w.empty() && (w.back() == L'\r' || w.back() == L'\n' || w.back() == L' ')) w.pop_back();
    return ToUtf8(w);
}

std::string LastErrorText(DWORD err) {
    if (err == 0) err = GetLastError();

    std::string text;
    HMODULE winhttp = nullptr;
    if (err >= 12000 && err < 13000) {
        winhttp = LoadLibraryW(L"winhttp.dll");
        if (winhttp) text = FormatMessageFrom(err, winhttp);
    }
    if (text.empty()) text = FormatMessageFrom(err, nullptr);
    if (winhttp) FreeLibrary(winhttp);
    if (text.empty()) text = "未知错误";

    char code[32];
    std::snprintf(code, sizeof(code), " (0x%08lX)", static_cast<unsigned long>(err));
    return text + code;
}

void WaitForSpaceKey() {
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    DWORD mode = 0;
    if (!GetConsoleMode(in, &mode)) return;

    SayLine();
    Say("按空格键退出 ...");

    DWORD oldMode = mode;
    SetConsoleMode(in, (mode & ~(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT)) | ENABLE_PROCESSED_INPUT);
    FlushConsoleInputBuffer(in);

    INPUT_RECORD rec{};
    DWORD read = 0;
    for (;;) {
        if (!ReadConsoleInputW(in, &rec, 1, &read) || read == 0) break;
        if (rec.EventType == KEY_EVENT && rec.Event.KeyEvent.bKeyDown &&
            rec.Event.KeyEvent.wVirtualKeyCode == VK_SPACE)
            break;
    }

    SetConsoleMode(in, oldMode);
    SayLine();
}

std::string Trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && std::isspace(static_cast<unsigned char>(s[b]))) ++b;
    while (e > b && std::isspace(static_cast<unsigned char>(s[e - 1]))) --e;
    return s.substr(b, e - b);
}

bool ReadAnswer(std::string& out) {
    if (!std::getline(std::cin, out)) return false;
    out = Trim(out);
    return true;
}

bool AskYesNo(const std::string& question, bool defaultYes, const Options& o) {
    Say(question + (defaultYes ? " [Y/n] " : " [y/N] "));
    if (o.assumeYes) {
        SayLine(defaultYes ? "是（--yes 自动选择）" : "否（--yes 自动选择）");
        return defaultYes;
    }
    std::string line;
    if (!ReadAnswer(line)) {
        SayLine("（读不到输入，采用默认值）");
        return defaultYes;
    }
    if (line.empty()) return defaultYes;
    char c = static_cast<char>(std::tolower(static_cast<unsigned char>(line[0])));
    if (c == 'y') return true;
    if (c == 'n') return false;
    SayLine("请回答 y 或 n。");
    return AskYesNo(question, defaultYes, o);
}

std::wstring ExpandPath(const std::wstring& in) {
    if (in.empty()) return in;
    wchar_t buf[32767];
    DWORD n = ExpandEnvironmentStringsW(in.c_str(), buf, 32767);
    std::wstring p = (n > 0 && n <= 32767) ? std::wstring(buf) : in;
    while (p.size() > 3 && (p.back() == L'\\' || p.back() == L'/')) p.pop_back();
    return p;
}

bool IsAbsolutePath(const std::wstring& p) {
    if (p.size() >= 2 && std::iswalpha(p[0]) && p[1] == L':') return true;
    if (p.rfind(L"\\\\", 0) == 0) return true;
    return false;
}

bool FileExists(const std::wstring& p) {
    DWORD a = GetFileAttributesW(p.c_str());
    return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

bool DirExists(const std::wstring& p) {
    DWORD a = GetFileAttributesW(p.c_str());
    return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}

bool IsSystemDir(const std::wstring& p) {
    return _wcsnicmp(p.c_str(), L"C:\\Program Files", 16) == 0 ||
           _wcsnicmp(p.c_str(), L"C:\\Windows", 10) == 0;
}

std::wstring ParentDir(const std::wstring& file) {
    size_t pos = file.find_last_of(L"\\/");
    return pos == std::wstring::npos ? std::wstring() : file.substr(0, pos);
}

std::wstring JoinPath(const std::wstring& dir, const std::wstring& name) {
    if (dir.empty()) return name;
    if (dir.back() == L'\\' || dir.back() == L'/') return dir + name;
    return dir + L"\\" + name;
}

std::wstring AskInstallDir(const std::wstring& defaultDir, const Options& o) {
    for (;;) {
        Say("安装位置 [" + ToUtf8(defaultDir) + "]: ");
        if (o.assumeYes) {
            SayLine("（--yes 采用默认值）");
            return defaultDir;
        }
        std::string line;
        if (!ReadAnswer(line)) {
            SayLine("（读不到输入，采用默认值）");
            return defaultDir;
        }
        std::wstring p = line.empty() ? defaultDir : ExpandPath(ToWide(line));
        if (p.empty()) {
            SayLine("路径不能为空，请重新输入。");
            continue;
        }
        if (!IsAbsolutePath(p)) {
            SayLine("请给绝对路径，例如 D:\\nodejs 或 C:\\Program Files\\nodejs。");
            continue;
        }
        return p;
    }
}

struct HandleCloser {
    void operator()(void* h) const {
        if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h);
    }
};
using HandlePtr = std::unique_ptr<void, HandleCloser>;

HINTERNET W(HANDLE h) { return static_cast<HINTERNET>(h); }

struct RunResult {
    DWORD exitCode = static_cast<DWORD>(-1);
    std::string output;
    bool started = false;
    DWORD lastError = 0;
};

RunResult RunProcess(const std::wstring& cmdLine, bool capture) {
    RunResult r;

    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;

    HandlePtr outRead, outWrite, nulInput;
    if (capture) {
        HANDLE rd = nullptr, wr = nullptr;
        if (!CreatePipe(&rd, &wr, &sa, 0)) {
            r.lastError = GetLastError();
            return r;
        }
        SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);
        outRead.reset(rd);
        outWrite.reset(wr);

        nulInput.reset(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa,
                                   OPEN_EXISTING, 0, nullptr));
    }

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    if (capture) {
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdOutput = outWrite.get();
        si.hStdError = outWrite.get();
        si.hStdInput = (nulInput.get() == INVALID_HANDLE_VALUE) ? nullptr : nulInput.get();
    }

    PROCESS_INFORMATION pi{};
    std::vector<wchar_t> buf(cmdLine.begin(), cmdLine.end());
    buf.push_back(L'\0');

    BOOL ok = CreateProcessW(nullptr, buf.data(), nullptr, nullptr,
                             capture ? TRUE : FALSE, 0, nullptr, nullptr, &si, &pi);
    if (!ok) {
        r.lastError = GetLastError();
        return r;
    }
    HandlePtr proc(pi.hProcess), thread(pi.hThread);
    r.started = true;

    if (capture) {
        outWrite.reset();
        char chunk[4096];
        for (;;) {
            DWORD got = 0;
            if (!ReadFile(outRead.get(), chunk, sizeof(chunk), &got, nullptr) || got == 0) break;
            r.output.append(chunk, got);
        }
    }

    WaitForSingleObject(proc.get(), INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(proc.get(), &code);
    r.exitCode = code;
    return r;
}

std::wstring QuoteArg(const std::wstring& a) {
    std::wstring out = L"\"";
    size_t backslashes = 0;
    for (wchar_t c : a) {
        if (c == L'\\') {
            ++backslashes;
            out.push_back(c);
        } else if (c == L'"') {
            out.append(backslashes + 1, L'\\');
            out.push_back(L'"');
            backslashes = 0;
        } else {
            backslashes = 0;
            out.push_back(c);
        }
    }
    out.append(backslashes, L'\\');
    out.push_back(L'"');
    return out;
}

struct OsVersionInfo {
    ULONG dwOSVersionInfoSize;
    ULONG dwMajorVersion;
    ULONG dwMinorVersion;
    ULONG dwBuildNumber;
    ULONG dwPlatformId;
    WCHAR szCSDVersion[128];
};

struct OsVersion {
    DWORD major = 0, minor = 0, build = 0;
};

std::optional<OsVersion> QueryOsVersion() {
    using RtlGetVersionFn = LONG(WINAPI*)(OsVersionInfo*);
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (!ntdll) return std::nullopt;
    auto fn = reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion"));
    if (!fn) return std::nullopt;

    OsVersionInfo vi{};
    vi.dwOSVersionInfoSize = sizeof(vi);
    if (fn(&vi) != 0) return std::nullopt;

    OsVersion v;
    v.major = vi.dwMajorVersion;
    v.minor = vi.dwMinorVersion;
    v.build = vi.dwBuildNumber;
    return v;
}

std::string OsDisplayName(const OsVersion& v) {
    if (v.major == 10 && v.build >= kWin11Build) return "Windows 11";
    if (v.major == 10) return "Windows 10";
    if (v.major == 6 && v.minor == 3) return "Windows 8.1";
    if (v.major == 6 && v.minor == 2) return "Windows 8";
    if (v.major == 6 && v.minor == 1) return "Windows 7";
    if (v.major == 6 && v.minor == 0) return "Windows Vista";
    if (v.major == 5 && v.minor == 1) return "Windows XP";
    return "未知系统";
}

bool IsSupportedOs(const OsVersion& v) {
    return (v.major > 10) || (v.major == 10 && v.build >= kWin10Build);
}

bool CheckWindowsVersion() {
    Say("[1/4] 检查系统版本 ... ");
    auto v = QueryOsVersion();
    if (!v) {
        SayLine("无法确定");
        Warn("读不到系统版本，跳过这项检查继续安装。");
        return true;
    }

    char ver[64];
    std::snprintf(ver, sizeof(ver), "%lu.%lu.%lu",
                  static_cast<unsigned long>(v->major), static_cast<unsigned long>(v->minor),
                  static_cast<unsigned long>(v->build));
    SayLine(OsDisplayName(*v) + " (" + ver + ")");

    if (!IsSupportedOs(*v)) {
        SayLine();
        Fail("当前系统是 " + OsDisplayName(*v) + " (" + ver + ")，低于 Windows 10，本程序不支持。");
        SayLine("EhBrowser 需要 Windows 10 及以上（64 位）。请在受支持的系统上安装。");
        return false;
    }
    return true;
}

bool IsElevated() {
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
    TOKEN_ELEVATION el{};
    DWORD len = 0;
    bool ok = GetTokenInformation(token, TokenElevation, &el, sizeof(el), &len) && el.TokenIsElevated;
    CloseHandle(token);
    return ok;
}

bool RelaunchElevated() {
    wchar_t exePath[MAX_PATH] = {};
    if (!GetModuleFileNameW(nullptr, exePath, MAX_PATH)) return false;

    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    std::wstring args;
    if (argv) {
        for (int i = 1; i < argc; ++i) {
            args += QuoteArg(argv[i]);
            args += L' ';
        }
        LocalFree(argv);
    }
    args += L"--elevated-retry";

    HINSTANCE rc = ShellExecuteW(nullptr, L"runas", exePath, args.c_str(), nullptr, SW_SHOWNORMAL);
    return reinterpret_cast<INT_PTR>(rc) > 32;
}

struct SemVer {
    int major = 0, minor = 0, patch = 0;
};

std::optional<SemVer> ParseVersion(const std::string& raw) {
    std::string s = Trim(raw);
    if (!s.empty() && (s[0] == 'v' || s[0] == 'V')) s.erase(0, 1);

    std::smatch m;
    static const std::regex re(R"(^(\d+)\.(\d+)\.(\d+))");
    if (!std::regex_search(s, m, re)) return std::nullopt;

    SemVer v;
    v.major = std::atoi(m[1].str().c_str());
    v.minor = std::atoi(m[2].str().c_str());
    v.patch = std::atoi(m[3].str().c_str());
    return v;
}

std::string VersionText(const SemVer& v) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%d.%d.%d", v.major, v.minor, v.patch);
    return buf;
}

std::optional<std::wstring> FindNodeOnPath() {
    wchar_t buf[MAX_PATH * 2] = {};
    DWORD n = SearchPathW(nullptr, L"node.exe", nullptr, static_cast<DWORD>(std::size(buf)), buf, nullptr);
    if (n > 0 && n < std::size(buf)) return std::wstring(buf);
    return std::nullopt;
}

std::optional<std::wstring> FindNodeInRegistry() {
    static const wchar_t* subKeys[] = {L"SOFTWARE\\Node.js", L"SOFTWARE\\WOW6432Node\\Node.js"};
    static const HKEY roots[] = {HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER};

    for (HKEY root : roots) {
        for (const wchar_t* sub : subKeys) {
            wchar_t buf[1024] = {};
            DWORD size = sizeof(buf);
            if (RegGetValueW(root, sub, L"InstallPath", RRF_RT_REG_SZ, nullptr, buf, &size) != ERROR_SUCCESS)
                continue;
            std::wstring dir = ExpandPath(buf);
            if (dir.empty()) continue;
            std::wstring exe = JoinPath(dir, L"node.exe");
            if (FileExists(exe)) return exe;
        }
    }
    return std::nullopt;
}

std::optional<std::wstring> FindCommonNodeExe() {
    wchar_t buf[32767] = {};
    DWORD n = GetEnvironmentVariableW(L"ProgramFiles", buf, 32767);
    if (n > 0 && n < 32767) {
        std::wstring exe = JoinPath(std::wstring(buf), L"nodejs\\node.exe");
        if (FileExists(exe)) return exe;
    }
    n = GetEnvironmentVariableW(L"LOCALAPPDATA", buf, 32767);
    if (n > 0 && n < 32767) {
        std::wstring exe = JoinPath(std::wstring(buf), L"Programs\\nodejs\\node.exe");
        if (FileExists(exe)) return exe;
    }
    return std::nullopt;
}

struct NodeStatus {
    bool found = false;
    std::wstring exe;
    std::optional<SemVer> version;
    std::string probeError;
};

NodeStatus DetectNode() {
    NodeStatus st;
    std::optional<std::wstring> exe = FindNodeOnPath();
    if (!exe) exe = FindNodeInRegistry();
    if (!exe) exe = FindCommonNodeExe();
    if (!exe) return st;

    st.found = true;
    st.exe = *exe;
    RunResult r = RunProcess(QuoteArg(st.exe) + L" --version", true);
    if (!r.started) {
        st.probeError = "无法启动 node.exe" + LastErrorText(r.lastError);
        return st;
    }
    if (r.exitCode != 0) {
        st.probeError = "node --version 退出码 " + std::to_string(r.exitCode) +
                        (r.output.empty() ? std::string() : "，输出：" + Trim(r.output));
        return st;
    }
    st.version = ParseVersion(r.output);
    if (!st.version) st.probeError = "node --version 的输出无法解析：" + Trim(r.output);
    return st;
}

bool NodeIsAcceptable(const NodeStatus& st) {
    return st.found && st.version && st.version->major >= kMinNodeMajor;
}

std::wstring DefaultNodeDir(bool elevated) {
    if (elevated) return L"C:\\Program Files\\nodejs";
    wchar_t buf[32767] = {};
    DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", buf, 32767);
    if (n > 0 && n < 32767) return JoinPath(std::wstring(buf), L"Programs\\nodejs");
    return L"C:\\Program Files\\nodejs";
}

std::wstring CpuArchTag() {
    SYSTEM_INFO si{};
    GetNativeSystemInfo(&si);
    switch (si.wProcessorArchitecture) {
        case PROCESSOR_ARCHITECTURE_ARM64: return L"arm64";
        case PROCESSOR_ARCHITECTURE_INTEL: return L"x86";
        default: return L"x64";
    }
}

struct WinHttpCloser {
    void operator()(void* h) const {
        if (h) WinHttpCloseHandle(W(h));
    }
};
using WinHttpPtr = std::unique_ptr<void, WinHttpCloser>;

struct HttpRequest {
    WinHttpPtr session;
    WinHttpPtr conn;
    WinHttpPtr req;

    explicit operator bool() const { return req != nullptr; }
    HINTERNET request() const { return W(req.get()); }
};

struct UrlParts {
    std::wstring host;
    std::wstring path;
    INTERNET_PORT port = 0;
    bool https = false;
};

bool CrackUrl(const std::wstring& url, UrlParts& out) {
    std::wstring copy = url;
    URL_COMPONENTS uc{};
    uc.dwStructSize = sizeof(uc);
    uc.dwSchemeLength = static_cast<DWORD>(-1);
    uc.dwHostNameLength = static_cast<DWORD>(-1);
    uc.dwUrlPathLength = static_cast<DWORD>(-1);
    uc.dwExtraInfoLength = static_cast<DWORD>(-1);

    if (!WinHttpCrackUrl(copy.data(), static_cast<DWORD>(copy.size()), 0, &uc)) return false;

    out.host.assign(uc.lpszHostName, uc.dwHostNameLength);
    out.path.assign(uc.lpszUrlPath, uc.dwUrlPathLength);
    if (uc.dwExtraInfoLength) out.path.append(uc.lpszExtraInfo, uc.dwExtraInfoLength);
    out.port = uc.nPort;
    out.https = uc.nScheme == INTERNET_SCHEME_HTTPS;
    return true;
}

HttpRequest OpenRequestWithMode(const std::wstring& url, DWORD accessType, std::string& error,
                                bool& gotResponse) {
    gotResponse = false;
    HttpRequest out;

    UrlParts u;
    if (!CrackUrl(url, u)) {
        error = "URL 解析失败：" + ToUtf8(url);
        gotResponse = true;
        return out;
    }

    out.session.reset(WinHttpOpen(L"EhBrowser-Installer/1.0", accessType,
                                  WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
    if (!out.session) {
        error = "WinHttpOpen 失败" + LastErrorText(0);
        return out;
    }
    WinHttpSetTimeouts(W(out.session.get()), 8000, 12000, 20000, 30000);

    out.conn.reset(WinHttpConnect(W(out.session.get()), u.host.c_str(), u.port, 0));
    if (!out.conn) {
        error = "连不上 " + ToUtf8(u.host) + LastErrorText(0);
        return out;
    }

    out.req.reset(WinHttpOpenRequest(W(out.conn.get()), L"GET", u.path.c_str(), nullptr,
                                     WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                     u.https ? WINHTTP_FLAG_SECURE : 0));
    if (!out.req) {
        error = "构造请求失败" + LastErrorText(0);
        return out;
    }

    if (!WinHttpSendRequest(out.request(), WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                            WINHTTP_NO_REQUEST_DATA, 0, 0, 0)) {
        error = "发送请求失败" + LastErrorText(0);
        return out;
    }
    if (!WinHttpReceiveResponse(out.request(), nullptr)) {
        error = "读取响应失败（网络或代理问题）" + LastErrorText(0);
        return out;
    }
    gotResponse = true;

    DWORD status = 0, len = sizeof(status);
    WinHttpQueryHeaders(out.request(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                        WINHTTP_HEADER_NAME_BY_INDEX, &status, &len, WINHTTP_NO_HEADER_INDEX);
    if (status != 200) {
        error = "服务器返回 HTTP " + std::to_string(status);
        out.req.reset();
        return out;
    }
    return out;
}

DWORD g_lastGoodProxyMode = 0;

HttpRequest OpenRequest(const std::wstring& url, std::string& error) {
    struct Mode {
        DWORD value;
        const char* name;
    };
    static const Mode modes[] = {
        {WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, "自动检测代理"},
        {WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, "系统代理设置"},
        {WINHTTP_ACCESS_TYPE_NO_PROXY, "直连"},
    };

    std::vector<const Mode*> order;
    if (g_lastGoodProxyMode != 0) {
        for (const Mode& m : modes)
            if (m.value == g_lastGoodProxyMode) order.push_back(&m);
    }
    for (const Mode& m : modes)
        if (m.value != g_lastGoodProxyMode) order.push_back(&m);

    std::string firstError;
    bool haveFirstError = false;
    for (size_t i = 0; i < order.size(); ++i) {
        bool gotResponse = false;
        std::string err;
        HttpRequest req = OpenRequestWithMode(url, order[i]->value, err, gotResponse);
        if (req) {
            if (i > 0)
                SayLine("  提示：" + std::string(order[0]->name) + "不通，已改用" + order[i]->name + "。");
            g_lastGoodProxyMode = order[i]->value;
            return req;
        }
        if (gotResponse) {
            error = err;
            return req;
        }
        if (!haveFirstError) {
            firstError = err;
            haveFirstError = true;
        }
    }
    error = firstError;
    return HttpRequest{};
}

std::optional<std::string> HttpGetText(const std::wstring& url, std::string& error) {
    constexpr int kAttempts = 3;

    for (int attempt = 1; attempt <= kAttempts; ++attempt) {
        HttpRequest req = OpenRequest(url, error);
        if (!req) return std::nullopt;

        std::string body;
        bool readFailed = false;
        for (;;) {
            DWORD avail = 0;
            if (!WinHttpQueryDataAvailable(req.request(), &avail)) {
                error = "读响应失败" + LastErrorText(0);
                readFailed = true;
                break;
            }
            if (avail == 0) break;
            std::vector<char> buf(std::min<DWORD>(avail, 64 * 1024));
            DWORD got = 0;
            if (!WinHttpReadData(req.request(), buf.data(), static_cast<DWORD>(buf.size()), &got)) {
                error = "读响应失败" + LastErrorText(0);
                readFailed = true;
                break;
            }
            if (got == 0) break;
            body.append(buf.data(), got);
        }

        if (!readFailed && !body.empty()) return body;
        if (!readFailed) error = "服务器返回了空响应";

        if (attempt < kAttempts) {
            SayLine("  取数据失败（" + error + "），重试 " + std::to_string(attempt) + "/" +
                    std::to_string(kAttempts - 1) + " ...");
            Sleep(1000u * static_cast<DWORD>(attempt));
        }
    }
    return std::nullopt;
}

std::string FormatSize(unsigned long long bytes) {
    char buf[64];
    if (bytes >= 1024ull * 1024 * 1024)
        std::snprintf(buf, sizeof(buf), "%.2f GB", bytes / 1024.0 / 1024 / 1024);
    else if (bytes >= 1024ull * 1024)
        std::snprintf(buf, sizeof(buf), "%.1f MB", bytes / 1024.0 / 1024);
    else if (bytes >= 1024ull)
        std::snprintf(buf, sizeof(buf), "%.0f KB", bytes / 1024.0);
    else
        std::snprintf(buf, sizeof(buf), "%llu B", bytes);
    return buf;
}

bool DownloadOnce(const std::wstring& url, const std::wstring& dest, std::string& error,
                  bool& retryable) {
    retryable = false;

    HttpRequest req = OpenRequest(url, error);
    if (!req) return false;

    unsigned long long total = 0;
    DWORD clen = 0, clenSize = sizeof(clen);
    if (WinHttpQueryHeaders(req.request(), WINHTTP_QUERY_CONTENT_LENGTH | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &clen, &clenSize, WINHTTP_NO_HEADER_INDEX))
        total = clen;

    HandlePtr file(CreateFileW(dest.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                               FILE_ATTRIBUTE_NORMAL, nullptr));
    if (file.get() == INVALID_HANDLE_VALUE) {
        error = "无法写入 " + ToUtf8(dest) + LastErrorText(0);
        return false;
    }

    retryable = true;
    unsigned long long written = 0;
    int lastPercent = -1;
    for (;;) {
        DWORD avail = 0;
        if (!WinHttpQueryDataAvailable(req.request(), &avail)) {
            error = "下载中断" + LastErrorText(0);
            return false;
        }
        if (avail == 0) break;

        std::vector<char> buf(std::min<DWORD>(avail, 128 * 1024));
        DWORD got = 0;
        if (!WinHttpReadData(req.request(), buf.data(), static_cast<DWORD>(buf.size()), &got)) {
            error = "读取数据失败" + LastErrorText(0);
            return false;
        }
        if (got == 0) break;

        DWORD wrote = 0;
        if (!WriteFile(file.get(), buf.data(), got, &wrote, nullptr) || wrote != got) {
            error = "写入文件失败" + LastErrorText(0);
            return false;
        }
        written += wrote;

        if (total > 0) {
            int percent = static_cast<int>(written * 100 / total);
            if (percent != lastPercent) {
                lastPercent = percent;
                Say("\r  下载中 " + std::to_string(percent) + "%  (" + FormatSize(written) + " / " +
                    FormatSize(total) + ")   ");
            }
        } else {
            Say("\r  已下载 " + FormatSize(written) + "   ");
        }
    }
    SayLine();

    if (written == 0) {
        error = "服务器返回了空内容";
        return false;
    }
    if (total > 0 && written != total) {
        error = "文件不完整：应为 " + FormatSize(total) + "，实际 " + FormatSize(written);
        return false;
    }
    return true;
}

bool HttpDownloadFile(const std::wstring& url, const std::wstring& dest, std::string& error) {
    constexpr int kAttempts = 3;

    for (int attempt = 1; attempt <= kAttempts; ++attempt) {
        bool retryable = false;
        std::string err;
        if (DownloadOnce(url, dest, err, retryable)) return true;

        error = err;
        if (!retryable) return false;
        if (attempt < kAttempts) {
            SayLine("  下载失败（" + err + "），重试 " + std::to_string(attempt) + "/" +
                    std::to_string(kAttempts - 1) + " ...");
            Sleep(1000u * static_cast<DWORD>(attempt));
        }
    }
    return false;
}

struct NodeRelease {
    std::wstring version;
    std::wstring url;
};

std::optional<NodeRelease> ResolveLatestNode(int major, std::string& error) {
    auto body = HttpGetText(L"https://nodejs.org/dist/index.json", error);
    if (!body) return std::nullopt;

    std::regex re("\"version\"\\s*:\\s*\"v" + std::to_string(major) + R"(\.(\d+)\.(\d+))" + "\"");
    std::smatch m;
    if (!std::regex_search(*body, m, re)) {
        error = "在 nodejs.org 的版本清单里没找到 v" + std::to_string(major) + ".x";
        return std::nullopt;
    }

    NodeRelease rel;
    rel.version = L"v" + ToWide(std::to_string(major)) + L"." + ToWide(m[1].str()) + L"." + ToWide(m[2].str());
    rel.url = L"https://nodejs.org/dist/" + rel.version + L"/node-" + rel.version + L"-" +
              CpuArchTag() + L".msi";
    return rel;
}

std::wstring TempWorkDir() {
    wchar_t buf[MAX_PATH] = {};
    DWORD n = GetTempPathW(MAX_PATH, buf);
    std::wstring base = (n > 0 && n < MAX_PATH) ? std::wstring(buf) : L"C:\\Windows\\Temp\\";
    std::wstring dir = JoinPath(base, L"EhBrowserInstaller");
    CreateDirectoryW(dir.c_str(), nullptr);
    return dir;
}

std::string MsiErrorHint(DWORD code) {
    switch (code) {
        case 0: return {};
        case 1602: return "用户取消了安装。";
        case 1603: return "安装失败。常见原因：权限不足、已装更高版本、或磁盘空间不够。";
        case 1618: return "另一个安装程序正在运行，稍后重试。";
        case 1619: return "无法打开安装包（文件可能没下全）。";
        case 1620: return "安装包无效。";
        case 1638: return "已经安装了更新的版本。";
        case 1641: return "安装完成，需要重启。";
        case 3010: return "安装完成，需要重启才生效。";
        default: return {};
    }
}

struct NpmPaths {
    std::wstring nodeExe;
    std::wstring npmCliJs;
    std::wstring npmCmd;
};

NpmPaths ResolveNpm(const std::wstring& nodeExe) {
    NpmPaths p;
    p.nodeExe = nodeExe;
    std::wstring dir = ParentDir(nodeExe);
    p.npmCliJs = JoinPath(dir, L"node_modules\\npm\\bin\\npm-cli.js");
    p.npmCmd = JoinPath(dir, L"npm.cmd");
    return p;
}

std::wstring NpmCommandLine(const NpmPaths& p, const std::vector<std::wstring>& npmArgs) {
    std::wstring args;
    for (const auto& a : npmArgs) args += L" " + QuoteArg(a);

    if (FileExists(p.npmCliJs)) {
        return QuoteArg(p.nodeExe) + L" " + QuoteArg(p.npmCliJs) + args;
    }

    return L"cmd.exe /c \"\"" + p.npmCmd + L"\"" + args + L"\"";
}

std::optional<std::wstring> QueryNpmGlobalPrefix(const NpmPaths& p) {
    RunResult r = RunProcess(NpmCommandLine(p, {L"prefix", L"-g"}), true);
    if (!r.started || r.exitCode != 0) return std::nullopt;

    std::optional<std::wstring> best;
    size_t start = 0;
    for (;;) {
        size_t nl = r.output.find('\n', start);
        std::string line = Trim(r.output.substr(start, nl == std::string::npos ? std::string::npos : nl - start));
        if (!line.empty() && (line.find(":\\") != std::string::npos || line.rfind("\\\\", 0) == 0))
            best = ToWide(line);
        if (nl == std::string::npos) break;
        start = nl + 1;
    }
    if (best) best = ExpandPath(*best);
    return best;
}

std::optional<std::string> ReadEhBrowserInstalledVersion(const std::wstring& prefix) {
    std::wstring pkg = JoinPath(JoinPath(prefix, L"node_modules\\ehbrowser"), L"package.json");
    HANDLE h = CreateFileW(pkg.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return std::nullopt;
    HandlePtr file(h);

    LARGE_INTEGER size{};
    if (!GetFileSizeEx(file.get(), &size) || size.QuadPart <= 0 || size.QuadPart > 4 * 1024 * 1024)
        return std::nullopt;

    std::string content(static_cast<size_t>(size.QuadPart), '\0');
    DWORD got = 0;
    if (!ReadFile(file.get(), content.data(), static_cast<DWORD>(content.size()), &got, nullptr))
        return std::nullopt;
    content.resize(got);

    std::smatch m;

    std::regex re(R"re("version"\s*:\s*"([^"]+)")re");
    if (std::regex_search(content, m, re)) return m[1].str();
    return std::nullopt;
}

// installDir 是 npm 全局目录（快捷方式要把启动器释放到这里）；拿不到全局前缀时退回 node.exe 旁边
int InstallEhBrowser(const std::wstring& nodeExe, const Options& o, std::wstring& installDir) {
    SayLine();
    Say("[3/4] 安装 ehbrowser ...");
    SayLine();

    NpmPaths npm = ResolveNpm(nodeExe);
    installDir = ParentDir(nodeExe);
    const std::vector<std::wstring> installArgs = {L"install", L"-g", kNpmPackage, L"--no-fund",
                                                   L"--no-audit"};

    if (!FileExists(npm.npmCliJs) && !FileExists(npm.npmCmd)) {
        if (o.dryRun) {
            SayLine("  --dry-run：Node.js 还没装（上面只演示了安装步骤），这里仅打印将要执行的命令。");
            SayLine("  执行：" + ToUtf8(NpmCommandLine(npm, installArgs)));
            return kExitOk;
        }
        Fail("在 " + ToUtf8(ParentDir(nodeExe)) + " 里找不到 npm，Node.js 安装可能不完整。");
        return kExitEhBrowserFailed;
    }

    auto prefix = QueryNpmGlobalPrefix(npm);
    if (prefix) {
        installDir = *prefix;
        if (auto old = ReadEhBrowserInstalledVersion(*prefix))
            SayLine("  检测到已安装 ehbrowser " + *old + "，将检查并升级到最新版。");
        SayPath("  全局安装目录：", *prefix);
    }

    std::wstring cmd = NpmCommandLine(npm, installArgs);
    SayLine("  执行：" + ToUtf8(cmd));

    if (o.dryRun) {
        SayLine("  --dry-run：跳过实际安装。");
        return kExitOk;
    }

    SayLine("  正在安装（需要联网，首次可能要一两分钟）...");
    RunResult r = RunProcess(cmd, false);
    if (!r.started) {
        Fail("无法启动 npm" + LastErrorText(r.lastError));
        return kExitEhBrowserFailed;
    }
    if (r.exitCode != 0) {
        Fail("npm 退出码 " + std::to_string(r.exitCode) + "，ehbrowser 安装失败。");
        SayLine("  常见原因：网络/代理不通、npm registry 被拦、或磁盘空间不足。");
        SayLine("  可手动重试：" + ToUtf8(cmd));
        return kExitEhBrowserFailed;
    }

    if (!prefix) prefix = QueryNpmGlobalPrefix(npm);
    if (prefix) installDir = *prefix;
    std::wstring shim = JoinPath(installDir, L"ehbrowser.cmd");

    SayLine();
    if (auto ver = ReadEhBrowserInstalledVersion(installDir))
        SayLine("ehbrowser " + *ver + " 安装完成。");
    else
        SayLine("ehbrowser 安装完成。");
    SayPath("  命令位置：", shim);
    SayLine("  运行方式：新开一个终端，输入 ehbrowser");
    SayLine("  （首次运行会创建配置目录与默认配置文件，并打开界面地址）");

    if (!FileExists(shim))
        Warn("没在预期位置看到 ehbrowser.cmd；若命令找不到，请重开终端刷新 PATH。");
    return kExitOk;
}

// ── 快捷方式 ──────────────────────────────────────────────────

std::string HResultText(HRESULT hr) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), " (0x%08lX)", static_cast<unsigned long>(hr));
    return buf;
}

/** 已知文件夹的路径：桌面用 FOLDERID_Desktop，这样能跟随 OneDrive 之类的桌面重定向 */
std::optional<std::wstring> KnownFolderPath(const KNOWNFOLDERID& id) {
    PWSTR raw = nullptr;
    if (FAILED(SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, nullptr, &raw))) return std::nullopt;
    std::wstring path = raw ? raw : L"";
    if (raw) CoTaskMemFree(raw);
    if (path.empty()) return std::nullopt;
    return path;
}

/** 把安装器里内嵌的启动器写出来（覆盖旧的）。失败多半是它正在运行、文件被占 */
bool ExtractEmbeddedLauncher(const std::wstring& dest, std::string& error) {
    HRSRC res = FindResourceW(nullptr, kLauncherResource, RT_RCDATA);
    if (!res) {
        error = "安装器里没有内嵌启动器资源" + LastErrorText(0);
        return false;
    }
    const DWORD size = SizeofResource(nullptr, res);
    HGLOBAL loaded = LoadResource(nullptr, res);
    const void* data = loaded ? LockResource(loaded) : nullptr;
    if (!data || size == 0) {
        error = "内嵌启动器资源是空的" + LastErrorText(0);
        return false;
    }

    HANDLE file = CreateFileW(dest.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        error = "写入 " + ToUtf8(dest) + " 失败" + LastErrorText(0);
        return false;
    }
    HandlePtr guard(file);

    DWORD written = 0;
    if (!WriteFile(file, data, size, &written, nullptr) || written != size) {
        error = "写入 " + ToUtf8(dest) + " 不完整" + LastErrorText(0);
        return false;
    }
    return true;
}

/** 写一个 .lnk：目标、参数、工作目录、图标、备注 */
bool CreateShortcutFile(const std::wstring& lnkPath, const std::wstring& target, const std::wstring& arguments,
                        const std::wstring& workDir, const std::wstring& icon, const std::wstring& description,
                        std::string& error) {
    IShellLinkW* link = nullptr;
    HRESULT hr = CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_IShellLinkW,
                                  reinterpret_cast<void**>(&link));
    if (FAILED(hr) || !link) {
        error = "无法创建 IShellLink" + HResultText(hr);
        return false;
    }

    link->SetPath(target.c_str());
    link->SetArguments(arguments.c_str());
    link->SetWorkingDirectory(workDir.c_str());
    link->SetDescription(description.c_str());
    if (!icon.empty()) link->SetIconLocation(icon.c_str(), 0);

    IPersistFile* persist = nullptr;
    hr = link->QueryInterface(IID_IPersistFile, reinterpret_cast<void**>(&persist));
    if (FAILED(hr) || !persist) {
        error = "无法取得 IPersistFile" + HResultText(hr);
        link->Release();
        return false;
    }

    hr = persist->Save(lnkPath.c_str(), TRUE);
    persist->Release();
    link->Release();
    if (FAILED(hr)) {
        error = "写入 " + ToUtf8(lnkPath) + " 失败" + HResultText(hr);
        return false;
    }
    return true;
}

/*
 * [4/4] 释放隐藏启动器，再建桌面与开始菜单快捷方式。
 * 快捷方式没建成不算安装失败（应用已经装好了，退出码仍是 0），但会逐条报出来。
 */
void InstallShortcuts(const std::wstring& installDir, const std::wstring& nodeExe, const Options& o) {
    if (installDir.empty()) {
        Warn("没拿到全局安装目录，跳过创建快捷方式。");
        return;
    }

    const bool want = o.createShortcutsSet ? o.createShortcuts
                                           : AskYesNo("是否在桌面和开始菜单创建 EhBrowser 快捷方式？", true, o);
    if (!want) {
        SayLine("  已跳过。");
        return;
    }

    const std::wstring launcher = JoinPath(installDir, kLauncherFileName);
    if (o.dryRun) {
        SayLine("  --dry-run：不释放启动器、不创建快捷方式。");
        SayPath("  启动器会释放到：", launcher);
        return;
    }

    std::string error;
    if (ExtractEmbeddedLauncher(launcher, error)) {
        SayPath("  启动器：", launcher);
    } else if (FileExists(launcher)) {
        // 正在运行的实例占着这个文件，覆盖会失败；沿用现有那份就行
        Warn("没能覆盖启动器（托盘还在运行），沿用现有版本；要更新它先右键托盘退出：" + error);
    } else {
        Warn("释放启动器失败：" + error + "，跳过创建快捷方式。");
        return;
    }

    const HRESULT hrInit = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(hrInit) && hrInit != RPC_E_CHANGED_MODE) {
        Warn("COM 初始化失败" + HResultText(hrInit) + "，跳过创建快捷方式。");
        return;
    }
    const bool comOwned = SUCCEEDED(hrInit);

    struct Target {
        const KNOWNFOLDERID* folder;
        const char* label; // UTF-8 显示名
    };
    const Target targets[] = {
        {&FOLDERID_Desktop, "桌面"},
        {&FOLDERID_Programs, "开始菜单"},
    };

    for (const Target& t : targets) {
        auto dir = KnownFolderPath(*t.folder);
        if (!dir) {
            Warn(std::string("找不到") + t.label + "目录，跳过。");
            continue;
        }
        const std::wstring lnk = JoinPath(*dir, kShortcutName);
        std::string err;
        if (CreateShortcutFile(lnk, launcher, kShortcutArguments, installDir, nodeExe,
                               L"EhBrowser - E-Hentai 浏览器", err)) {
            SayLine(std::string("  已创建") + t.label + "快捷方式：" + ToUtf8(lnk));
        } else {
            Warn(std::string("创建") + t.label + "快捷方式失败：" + err);
        }
    }

    if (comOwned) CoUninitialize();
}

bool HandleMissingNode(const Options& o, bool elevated, std::wstring& nodeExeOut, int& exitCode) {
    if (o.checkOnly) {
        Warn("未检测到符合要求的 Node.js，需要安装（--check 模式下不做任何修改）。");
        Say("  将要安装的版本：");
        std::string err;
        if (auto rel = ResolveLatestNode(kMinNodeMajor, err)) {
            SayLine(ToUtf8(rel->version));
            SayPath("  下载地址：", rel->url);
        } else {
            SayLine("无法确定（" + err + "）");
        }
        SayPath("  默认安装位置：", o.nodeDirSet ? ExpandPath(o.nodeDir) : DefaultNodeDir(elevated));
        exitCode = kExitNodeFailed;
        return false;
    }

    SayLine();
    SayLine("EhBrowser 需要 Node.js " + std::to_string(kMinNodeMajor) + " 或更高版本。");
    if (!AskYesNo("是否现在安装 Node.js？", true, o)) {
        SayLine("已取消。你可以自行安装 Node.js 后重新运行本程序。");
        SayPath("下载地址：", kNodeDownloadPage);
        exitCode = kExitCancelled;
        return false;
    }

    if (!elevated) {
        SayLine();
        Warn("当前不是管理员，Node.js 官方 MSI 安装通常需要管理员权限。");
        if (!o.elevatedRetry && !o.assumeYes && AskYesNo("是否以管理员身份重新启动本程序？", true, o)) {
            if (RelaunchElevated()) {
                SayLine("已在新的管理员窗口中重新启动，本窗口可以关闭。");
                exitCode = kExitOk;
            } else {
                Fail("提权启动失败" + LastErrorText(0));
                exitCode = kExitNodeFailed;
            }
            return false;
        }
        SayLine("  继续安装。若 MSI 因权限不足失败（退出码 1603），请用管理员终端重跑本程序。");
    }

    std::wstring dir = o.nodeDirSet ? ExpandPath(o.nodeDir) : DefaultNodeDir(elevated);
    if (o.nodeDirSet) {
        SayPath("安装位置（来自 --node-dir）：", dir);
    } else {
        dir = AskInstallDir(dir, o);
    }

    if (!elevated && IsSystemDir(dir))
        Warn(ToUtf8(dir) + " 属于系统目录，当前不是管理员，安装很可能失败。");

    if (DirExists(dir) && !FileExists(JoinPath(dir, L"node.exe"))) {
        WIN32_FIND_DATAW fd{};
        HANDLE h = FindFirstFileW(JoinPath(dir, L"*").c_str(), &fd);
        bool nonEmpty = h != INVALID_HANDLE_VALUE;
        if (h != INVALID_HANDLE_VALUE) FindClose(h);
        if (nonEmpty) {
            Warn(ToUtf8(dir) + " 已存在且不是空的，安装程序会往里面写入文件。");
            if (!AskYesNo("继续用这个目录？", true, o)) {
                SayLine("已取消。请重新运行并换一个目录。");
                exitCode = kExitCancelled;
                return false;
            }
        }
    }

    std::string err;
    Say("  查询 Node.js 最新 " + std::to_string(kMinNodeMajor) + ".x 版本 ... ");
    auto rel = ResolveLatestNode(kMinNodeMajor, err);
    if (!rel) {
        SayLine("失败");
        Fail(err);
        SayPath("  可手动下载安装后重跑本程序：", kNodeDownloadPage);
        exitCode = kExitNodeFailed;
        return false;
    }
    SayLine(ToUtf8(rel->version));

    std::wstring workDir = TempWorkDir();
    std::wstring msiPath = JoinPath(workDir, L"node-" + rel->version + L"-" + CpuArchTag() + L".msi");
    std::wstring logPath = JoinPath(workDir, L"node-install.log");
    std::wstring cmd = L"msiexec.exe /i " + QuoteArg(msiPath) + L" /qn /norestart INSTALLDIR=" +
                       QuoteArg(dir) + L" /l*v " + QuoteArg(logPath);

    SayPath("  下载地址：", rel->url);
    SayPath("  保存到：", msiPath);

    if (o.dryRun) {
        SayLine("  --dry-run：跳过下载与安装。将执行：" + ToUtf8(cmd));
        nodeExeOut = JoinPath(dir, L"node.exe");
        exitCode = kExitOk;
        return true;
    }

    if (!HttpDownloadFile(rel->url, msiPath, err)) {
        Fail("下载 Node.js 安装包失败：" + err);
        SayPath("  也可手动下载安装后重跑本程序：", kNodeDownloadPage);
        exitCode = kExitNodeFailed;
        return false;
    }

    SayLine("  正在安装（静默 MSI，可能需要一两分钟）...");
    RunResult r = RunProcess(cmd, false);
    if (!r.started) {
        Fail("无法启动 msiexec" + LastErrorText(r.lastError));
        exitCode = kExitNodeFailed;
        return false;
    }
    if (r.exitCode != 0 && r.exitCode != 3010 && r.exitCode != 1641) {
        Fail("Node.js 安装失败，msiexec 退出码 " + std::to_string(r.exitCode) + "。");
        if (std::string hint = MsiErrorHint(r.exitCode); !hint.empty()) SayLine("  " + hint);
        SayPath("  安装日志：", logPath);
        SayPath("  安装包保留在：", msiPath);
        exitCode = kExitNodeFailed;
        return false;
    }

    std::wstring installed = JoinPath(dir, L"node.exe");
    if (!FileExists(installed)) {
        Fail("安装程序报告成功，但没在 " + ToUtf8(installed) + " 找到 node.exe。");
        SayPath("  安装日志：", logPath);
        SayLine("  若实际装到了别处，可用 --node-dir 指定后重跑。");
        exitCode = kExitNodeFailed;
        return false;
    }

    RunResult vr = RunProcess(QuoteArg(installed) + L" --version", true);
    auto ver = (vr.started && vr.exitCode == 0) ? ParseVersion(vr.output) : std::nullopt;
    if (!ver || ver->major < kMinNodeMajor) {
        Fail("装出来的 Node.js 版本不符合要求：" + (ver ? VersionText(*ver) : std::string("无法识别")));
        SayPath("  安装日志：", logPath);
        exitCode = kExitNodeFailed;
        return false;
    }

    SayLine("  Node.js " + VersionText(*ver) + " 安装完成。");
    SayLine("  提示：当前终端里 node/npm 命令要新开窗口才生效；本程序后续步骤直接用绝对路径调用。");

    DeleteFileW(msiPath.c_str());
    DeleteFileW(logPath.c_str());

    nodeExeOut = installed;
    exitCode = kExitOk;
    return true;
}

int RunInstaller(const Options& o) {
    SayLine("EhBrowser 安装器 " + std::string(kInstallerVersion));
    SayLine("========================================");

    if (!CheckWindowsVersion()) return kExitUnsupportedOs;

    Say("[2/4] 检查 Node.js ... ");
    NodeStatus node = DetectNode();
    if (NodeIsAcceptable(node)) {
        SayLine("已安装 " + VersionText(*node.version));
        SayPath("  位置：", node.exe);
        if (node.version->major == kMinNodeMajor && node.version->minor < kMinNodeMinor) {
            Warn("Node " + VersionText(*node.version) + " 低于 ehbrowser 要求的 " +
                 std::to_string(kMinNodeMajor) + "." + std::to_string(kMinNodeMinor) +
                 ".0，安装可能失败，建议升级。");
        }
    } else {
        if (!node.found)
            SayLine("未检测到");
        else if (!node.version) {
            SayLine("检测到但无法识别版本：" + ToUtf8(node.exe));
            if (!node.probeError.empty()) SayLine("  " + node.probeError);
        } else {
            SayLine("版本过低 " + VersionText(*node.version));
            SayPath("  位置：", node.exe);
        }

        int exitCode = kExitNodeFailed;
        std::wstring nodeExe;
        if (!HandleMissingNode(o, IsElevated(), nodeExe, exitCode)) return exitCode;
        node.exe = nodeExe;
        node.version = SemVer{kMinNodeMajor, 0, 0};
    }

    if (o.checkOnly) {
        SayLine();
        SayLine("--check：环境检查结束，未做任何修改。");
        return kExitOk;
    }

    std::wstring installDir;
    const int code = InstallEhBrowser(node.exe, o, installDir);
    if (code != kExitOk) return code;

    SayLine();
    Say("[4/4] 创建快捷方式 ...");
    SayLine();
    InstallShortcuts(installDir, node.exe, o);
    return kExitOk;
}

int RunMain() {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv) {
        Fail("无法解析命令行参数" + LastErrorText(0));
        return kExitBadArgs;
    }

    Options o;
    std::wstring err;
    bool parsed = ParseArgs(argc, argv, o, err);
    LocalFree(argv);
    if (!parsed) {
        Fail(ToUtf8(err));
        SayLine();
        PrintHelp();
        return kExitBadArgs;
    }

    if (o.help) {
        PrintHelp();
        return kExitOk;
    }

    int code = RunInstaller(o);

    SayLine();
    if (code == kExitOk)
        SayLine("全部完成。");
    else
        SayLine("安装没有完成（退出码 " + std::to_string(code) + "）。");
    return code;
}

}

int main() {
    SetupConsole();
    int code = RunMain();
    WaitForSpaceKey();
    return code;
}
