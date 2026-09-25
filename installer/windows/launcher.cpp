/*
 * EhBrowser 启动器：GUI 子系统（自己没有控制台窗口）的隐藏启动 + 通知区域图标
 *
 * 整个被编进安装器的资源里，由安装器在装完后释放到 npm 全局目录
 * （见 main.cpp 的 InstallShortcuts）。桌面与开始菜单的快捷方式指向它，参数是 ehbrowser。
 *
 * 因为客户端以隐藏模式启动，所以本程序驻留在通知区域，右键菜单：
 *   打开浏览器 / 查看日志 / 重启客户端 / 关闭客户端
 * 「关闭客户端」连托盘一起退出；子进程被放进一个 job 对象（KILL_ON_JOB_CLOSE），
 * 所以连 cmd 带 node 一起收掉，不会留下孤儿进程；托盘自己被杀掉时也不会留下孤儿。
 *
 * 再双击一次快捷方式不会起第二个客户端：它按窗口类名找到已在跑的那个，请它打开浏览器。
 *
 * 命令先按 PATH 找；找不到时（cmd 的 9009）改用与自己同目录的 ehbrowser.cmd——安装器总是把
 * 这两样放在一起，而刚装完 Node 时 Explorer 的环境块可能还没刷新，这一步正好兜住。
 *
 * 由于没有控制台，没有可见的输出，所以子进程的 stdout/stderr 改写到
 * %LOCALAPPDATA%\ehbrowser\launcher.log（跨次启动往后追加，超过 1 MiB 时清空）。
 * 客户端启动横幅里的「地址：」「日志：」两行由本程序解析出来，托盘菜单的
 * 「打开浏览器」「查看日志」用的就是它们——自定义端口、自定义日志目录都不用另配。
 *
 * 「起来没有」以横幅里的「地址：」为准（它是 listen 成功之后才打印的）：只看进程还活着，
 * 会把「端口被占、卡在那儿」误判成起来了，托盘就挂着一个不能用的客户端。
 * 启动失败时用消息框把日志尾巴摆出来（隐藏模式最怕静默失败）；没有交互桌面时不弹，
 * 只记录日志：服务、SSH 这类会话里弹了没人点。
 *
 * 参数：ehbrowser-launcher.exe [--no-tray] [命令] [参数...]
 *   --no-tray  起完就退出，不驻留托盘（留给测试与诊断；命令默认 ehbrowser）
 */

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <windows.h>
#include <shellapi.h>

#include <cwchar>
#include <string>
#include <vector>

namespace {

/** 等服务开始监听最长等这么久（只有卡住的情况才会走满） */
constexpr DWORD kStartupTimeoutMs = 15000;

/** 等启动时轮询日志的间隔 */
constexpr DWORD kPollMs = 200;

/** 消息框里最多贴这么多日志 */
constexpr int kTailBytes = 4000;

/** 日志超过这么大就在下次启动时清掉，免得长年累月无限增长 */
constexpr LONGLONG kMaxLogBytes = 1024 * 1024;

/** 安装器放在本程序旁边的那份入口脚本（npm 生成的 shim） */
constexpr const wchar_t* kSiblingShim = L"ehbrowser.cmd";

/** 我们要跑的入口名（快捷方式给的就是它） */
constexpr const wchar_t* kEntryName = L"ehbrowser";

/** 托盘窗口的类名：第二个实例靠它找到已经在跑的那个 */
constexpr const wchar_t* kWindowClass = L"EhBrowserTrayWindow";

/** 客户端没起来时的兜底地址（与 src/main.ts 的默认端口一致） */
constexpr const wchar_t* kDefaultUrl = L"http://localhost:7727/";

/** 客户端日志文件名形如 ehbrowser-2026-09-25.log（见 src/services/log-service.ts） */
constexpr const wchar_t* kClientLogPattern = L"ehbrowser-*.log";

constexpr UINT kTrayId = 1;
constexpr UINT WM_TRAY = WM_APP + 1;
/** 第二个实例发来的「把界面调出来」 */
constexpr UINT WM_OPEN_BROWSER = WM_APP + 2;

enum MenuId : UINT {
    kMenuOpen = 1001,
    kMenuLogs,
    kMenuRestart,
    kMenuClose,
};

// ###[基础工具]####################################
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

std::wstring JoinPath(const std::wstring& dir, const std::wstring& name) {
    if (dir.empty()) return name;
    if (dir.back() == L'\\' || dir.back() == L'/') return dir + name;
    return dir + L"\\" + name;
}

std::wstring ParentDir(const std::wstring& path) {
    size_t pos = path.find_last_of(L"\\/");
    return pos == std::wstring::npos ? std::wstring() : path.substr(0, pos);
}

bool FileExists(const std::wstring& path) {
    DWORD attr = GetFileAttributesW(path.c_str());
    return attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

/** 当前窗口站是不是可见的（有交互桌面）。服务/SSH 会话里消息框没人点，弹了就是一直等 */
bool HasVisibleWindowStation() {
    HWINSTA station = GetProcessWindowStation();
    if (station == nullptr) return false;
    USEROBJECTFLAGS flags{};
    DWORD needed = 0;
    if (!GetUserObjectInformationW(station, UOI_FLAGS, &flags, sizeof(flags), &needed)) return false;
    return (flags.dwFlags & WSF_VISIBLE) != 0;
}

/** 比较入口名时不分大小写（都是 ASCII） */
std::wstring ToLowerAscii(const std::wstring& s) {
    std::wstring out;
    out.reserve(s.size());
    for (wchar_t c : s) out.push_back((c >= L'A' && c <= L'Z') ? static_cast<wchar_t>(c + 32) : c);
    return out;
}

/** 本程序所在目录：安装器把 shim 也放在这里 */
std::wstring SelfDirectory() {
    wchar_t buf[MAX_PATH] = {};
    DWORD n = GetModuleFileNameW(nullptr, buf, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) return {};
    return ParentDir(std::wstring(buf, n));
}

/** 不含空格与引号时按原样给出，否则加一层引号 */
std::wstring ArgText(const std::wstring& a) {
    if (!a.empty() && a.find_first_of(L" \t\"") == std::wstring::npos) return a;
    return L"\"" + a + L"\"";
}

/** 一律加引号并转义内部的引号：cmd /c 后面那一整串要用这个再包一层 */
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

// ###[日志]####################################

/** 日志目录：%LOCALAPPDATA%\ehbrowser；拿不到 LOCALAPPDATA 时退回 TEMP */
std::wstring LogDirectory() {
    wchar_t buf[32767] = {};
    DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", buf, 32767);
    std::wstring base = (n > 0 && n < 32767) ? std::wstring(buf) : std::wstring();
    if (base.empty()) {
        wchar_t tmp[MAX_PATH] = {};
        DWORD m = GetTempPathW(MAX_PATH, tmp);
        base = (m > 0 && m < MAX_PATH) ? std::wstring(tmp) : L".";
    }
    return JoinPath(base, L"ehbrowser");
}

std::wstring LogPath() {
    return JoinPath(LogDirectory(), L"launcher.log");
}

/**
 * 打开日志准备往后追加（跨次启动保留，方便回看上一次为什么失败）。
 * 超过 kMaxLogBytes 就先清空；返回可继承的写句柄，失败时返回 INVALID_HANDLE_VALUE
 */
HANDLE OpenLog(const std::wstring& path, SECURITY_ATTRIBUTES& sa) {
    CreateDirectoryW(LogDirectory().c_str(), nullptr); // 已存在时返回失败，忽略
    HANDLE h = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_ALWAYS,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return h;

    LARGE_INTEGER size{};
    if (GetFileSizeEx(h, &size) && size.QuadPart > kMaxLogBytes) {
        SetFilePointer(h, 0, nullptr, FILE_BEGIN);
        SetEndOfFile(h);
    } else {
        SetFilePointer(h, 0, nullptr, FILE_END);
    }
    return h;
}

void AppendLog(HANDLE log, const std::wstring& text) {
    if (log == INVALID_HANDLE_VALUE) return;
    const std::string bytes = ToUtf8(text);
    DWORD written = 0;
    WriteFile(log, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr);
}

/** 写一行启动器自己的日志（诊断用：托盘的行为没有控制台可看） */
void LogLine(const std::wstring& text) {
    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    HANDLE log = OpenLog(LogPath(), sa);
    if (log == INVALID_HANDLE_VALUE) return;
    AppendLog(log, text + L"\r\n");
    CloseHandle(log);
}

/** 日志当前大小，用来记住「本次运行从哪儿开始」 */
LONGLONG LogSize(const std::wstring& path) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return 0;
    LARGE_INTEGER size{};
    const bool ok = GetFileSizeEx(h, &size) != 0;
    CloseHandle(h);
    return ok ? size.QuadPart : 0;
}

/** 读日志里从 offset 起的全部内容 */
std::string ReadLogFrom(const std::wstring& path, LONGLONG offset) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return {};

    LARGE_INTEGER size{};
    if (!GetFileSizeEx(h, &size) || size.QuadPart <= offset) {
        CloseHandle(h);
        return {};
    }
    LARGE_INTEGER pos{};
    pos.QuadPart = offset;
    if (!SetFilePointerEx(h, pos, nullptr, FILE_BEGIN)) {
        CloseHandle(h);
        return {};
    }

    std::string data(static_cast<size_t>(size.QuadPart - offset), '\0');
    DWORD got = 0;
    const BOOL ok = ReadFile(h, data.data(), static_cast<DWORD>(data.size()), &got, nullptr);
    CloseHandle(h);
    if (!ok) return {};
    data.resize(got);
    return data;
}

/** 读日志末尾若干字节，用于失败时的消息框 */
std::string ReadLogTail(const std::wstring& path) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return {};

    LARGE_INTEGER size{};
    if (!GetFileSizeEx(h, &size) || size.QuadPart <= 0) {
        CloseHandle(h);
        return {};
    }

    const LONGLONG start = size.QuadPart > kTailBytes ? size.QuadPart - kTailBytes : 0;
    LARGE_INTEGER pos{};
    pos.QuadPart = start;
    if (!SetFilePointerEx(h, pos, nullptr, FILE_BEGIN)) {
        CloseHandle(h);
        return {};
    }

    std::string data(static_cast<size_t>(size.QuadPart - start), '\0');
    DWORD got = 0;
    const BOOL read = ReadFile(h, data.data(), static_cast<DWORD>(data.size()), &got, nullptr);
    CloseHandle(h);
    if (!read) return {};
    data.resize(got);

    // 从中间截断时开头可能只剩半行，丢掉第一个换行之前的内容
    if (start > 0) {
        size_t nl = data.find('\n');
        if (nl != std::string::npos) data.erase(0, nl + 1);
    }
    return data;
}

/** 统一的失败出路：写日志；有交互桌面时弹消息框把日志尾巴摆出来 */
void ReportFailure(const std::wstring& logPath, const std::wstring& headline) {
    LogLine(L"[启动器] " + headline);

    if (!HasVisibleWindowStation()) {
        // 没有交互桌面（服务、SSH 会话）：记录日志后直接跳过
        LogLine(L"[启动器] 当前会话没有可见桌面，跳过消息框");
        return;
    }

    std::wstring text = headline;
    text += L"\n\n常见原因：已经有一个 EhBrowser 在运行（端口被占），或者 Node.js / ehbrowser 没装好。";

    const std::string tail = ReadLogTail(logPath);
    if (!tail.empty()) {
        text += L"\n\n--- 日志末尾 ---\n";
        text += ToWide(tail);
    }
    text += L"\n\n完整日志：\n" + logPath;

    MessageBoxW(nullptr, text.c_str(), L"EhBrowser", MB_OK | MB_ICONERROR | MB_TOPMOST | MB_SETFOREGROUND);
}

// ###[进程]####################################

struct SpawnResult {
    bool started = false;
    bool inJob = false; // 是否成功挂进 job（挂不上就只能在退出时留下 node）
    DWORD startError = 0;
    HANDLE process = nullptr; // 交给调用方：等它退出、判成败、收摊
};

/** 建一个「句柄一关就把里面所有进程杀掉」的 job，用来连 cmd 带 node 一起收掉 */
HANDLE CreateKillOnCloseJob() {
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (job == nullptr) return nullptr;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info{};
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info, sizeof(info))) {
        CloseHandle(job);
        return nullptr;
    }
    return job;
}

/**
 * 起 cmd.exe 跑命令，全程无窗口。
 * 给了 job 就先挂起创建、放进 job 再放行——否则 cmd 可能在挂上去之前就把 node 生出来了，
 * 那样收摊时会漏掉 node。
 */
SpawnResult SpawnHidden(const std::wstring& command, HANDLE input, HANDLE output, HANDLE job) {
    SpawnResult r;

    wchar_t sysDir[MAX_PATH] = {};
    GetSystemDirectoryW(sysDir, MAX_PATH);
    // /d 跳过 AutoRun 脚本；/s 让 /c 后面的整串按原样处理（配合外面那层引号）
    const std::wstring cmdLine = QuoteArg(JoinPath(sysDir, L"cmd.exe")) + L" /d /s /c " + QuoteArg(command);

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = input;
    si.hStdOutput = output;
    si.hStdError = output;

    PROCESS_INFORMATION pi{};
    std::vector<wchar_t> buf(cmdLine.begin(), cmdLine.end());
    buf.push_back(L'\0');

    DWORD flags = CREATE_NO_WINDOW;
    if (job != nullptr) flags |= CREATE_SUSPENDED;

    if (!CreateProcessW(nullptr, buf.data(), nullptr, nullptr, TRUE, flags, nullptr, nullptr, &si, &pi)) {
        r.startError = GetLastError();
        return r;
    }
    r.started = true;

    if (job != nullptr) {
        r.inJob = AssignProcessToJobObject(job, pi.hProcess) != 0;
        ResumeThread(pi.hThread);
    }
    CloseHandle(pi.hThread);

    r.process = pi.hProcess; // 起完就返回：等多久、算不算成功，由调用方决定
    return r;
}

// ###[从启动横幅里取地址与日志目录]####################################

/** 取标记后面那一段：URL 到空白为止，目录到行尾为止（路径里可能有空格） */
bool TakeAfterMarker(const std::wstring& text, const wchar_t* marker, bool stopAtSpace, std::wstring& out) {
    const size_t at = text.find(marker);
    if (at == std::wstring::npos) return false;

    size_t i = at + std::wcslen(marker);
    const size_t begin = i;
    while (i < text.size()) {
        const wchar_t c = text[i];
        if (c == L'\r' || c == L'\n') break;
        if (c == 0x1b || c == 0x07) break; // ANSI 转义等控制字符
        if (stopAtSpace && (c == L' ' || c == L'\t')) break;
        ++i;
    }
    out.assign(text, begin, i - begin);
    while (!out.empty() && (out.back() == L' ' || out.back() == L'\t')) out.pop_back();
    return !out.empty();
}

/** 目录里最新的一个客户端日志文件（没有就返回空） */
std::wstring NewestClientLog(const std::wstring& dir) {
    if (dir.empty()) return {};
    WIN32_FIND_DATAW fd{};
    HANDLE h = FindFirstFileW(JoinPath(dir, kClientLogPattern).c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return {};

    std::wstring best;
    ULARGE_INTEGER bestTime{};
    do {
        if ((fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) continue;
        ULARGE_INTEGER t{};
        t.LowPart = fd.ftLastWriteTime.dwLowDateTime;
        t.HighPart = fd.ftLastWriteTime.dwHighDateTime;
        if (best.empty() || t.QuadPart > bestTime.QuadPart) {
            best = JoinPath(dir, fd.cFileName);
            bestTime = t;
        }
    } while (FindNextFileW(h, &fd) != 0);
    FindClose(h);
    return best;
}

// ###[托盘状态]####################################

struct State {
    HWND hwnd = nullptr;
    HICON icon = nullptr;
    bool trayAdded = false;
    HANDLE job = nullptr;
    HANDLE process = nullptr;
    std::wstring command;
    /** 与自己同目录那份 shim 的绝对路径；为空表示不用它、直接按 PATH 找 */
    std::wstring siblingShim;
    std::wstring logPath;
    std::wstring url;
    std::wstring logDir;
    LONGLONG runOffset = 0;
    UINT taskbarCreated = 0;
};

State g;

enum class StartOutcome { Running, Finished, Failed };

/** 定义在下面（StartClient 的等待循环要用） */
bool ParseBanner();

/** 客户端隐藏启动；成功且长驻时把进程句柄留在 g.process */
StartOutcome StartClient(bool useJob) {
    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;

    g.url.clear();
    g.logDir.clear();
    if (useJob && g.job == nullptr) g.job = CreateKillOnCloseJob();

    HANDLE log = OpenLog(g.logPath, sa);
    HANDLE devNull = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa,
                                 OPEN_EXISTING, 0, nullptr);

    HANDLE out = (log != INVALID_HANDLE_VALUE) ? log : devNull;
    if (out == INVALID_HANDLE_VALUE) out = nullptr;
    HANDLE in = (devNull == INVALID_HANDLE_VALUE) ? nullptr : devNull;

    // 先试与自己同目录的那份 shim（安装器把这两样放在一起，而刚装完 Node 时 Explorer 的 PATH
    // 可能还没刷新），它没起来再退回按 PATH 找。不能靠退出码判断「命令没找到」——cmd 对
    // 「找不到命令」和「命令自己失败」都给退出码 1，所以这里按目录定先后。
    std::wstring command = g.siblingShim.empty() ? g.command : g.siblingShim;
    const bool allowPathRetry = !g.siblingShim.empty();
    DWORD failureCode = 0;
    DWORD failureStart = 0;
    bool stuck = false;

    for (int attempt = 0; attempt < 2; ++attempt) {
        failureCode = 0;
        failureStart = 0;
        stuck = false;

        g.runOffset = LogSize(g.logPath);
        AppendLog(log, L"[启动器] 启动：" + command + L"\r\n");

        SpawnResult r = SpawnHidden(command, in, out, useJob ? g.job : nullptr);
        if (useJob && r.started && !r.inJob) {
            // 挂不上 job 只是收摊时可能漏掉 node，不影响客户端本身，所以只记一笔
            AppendLog(log, L"[启动器] 警告：进程没能放进 job，关闭托盘时可能留下 node\r\n");
        }

        bool running = false;
        if (r.started) {
            // 等服务开始监听：横幅里的「地址：」是 listen 成功之后才打印的。只看「进程还活着」
            // 会把「端口被占、卡在那里」误判成起来了，托盘就会挂着一个不能用的客户端。
            const DWORD deadline = GetTickCount() + kStartupTimeoutMs;
            for (;;) {
                if (WaitForSingleObject(r.process, kPollMs) == WAIT_OBJECT_0) {
                    GetExitCodeProcess(r.process, &failureCode);
                    break;
                }
                if (ParseBanner()) {
                    running = true;
                    break;
                }
                if (static_cast<LONG>(GetTickCount() - deadline) >= 0) {
                    stuck = true;
                    break;
                }
            }

            if (running) {
                g.process = r.process;
            } else {
                // 还赖着不走（stuck）就先收掉再重试，不然端口被它占着
                if (useJob && g.job != nullptr) {
                    TerminateJobObject(g.job, 0); // 连它下面的 node 一起
                } else {
                    TerminateProcess(r.process, 0);
                }
                WaitForSingleObject(r.process, 3000);
                CloseHandle(r.process);
            }
        } else {
            failureStart = r.startError;
        }

        if (running) break;
        if (allowPathRetry && attempt == 0) {
            AppendLog(log, L"[启动器] 同目录的 shim 没起来，退回按 PATH 找 " + g.command + L"\r\n");
            command = g.command;
            continue;
        }
        break;
    }

    if (log != INVALID_HANDLE_VALUE) CloseHandle(log);
    if (devNull != INVALID_HANDLE_VALUE) CloseHandle(devNull);

    if (g.process != nullptr) {
        LogLine(L"[启动器] 已就绪：地址=" + (g.url.empty() ? std::wstring(L"(未知)") : g.url) + L" 日志目录=" +
                (g.logDir.empty() ? std::wstring(L"(未知)") : g.logDir));
        return StartOutcome::Running;
    }

    if (stuck) {
        ReportFailure(g.logPath, L"EhBrowser 起来了但一直没开始监听（没等到启动地址），已结束它。");
        return StartOutcome::Failed;
    }
    if (failureStart != 0) {
        ReportFailure(g.logPath, L"无法启动 EhBrowser（系统错误码 " + std::to_wstring(failureStart) + L"）。");
        return StartOutcome::Failed;
    }
    if (failureCode == 0) return StartOutcome::Finished; // 命令跑完就退了（比如 --help）
    ReportFailure(g.logPath, L"EhBrowser 启动失败（退出码 " + std::to_wstring(failureCode) + L"）。");
    return StartOutcome::Failed;
}

/** 把本次运行的日志里那两行横幅解析出来；返回是否拿到了地址 */
bool ParseBanner() {
    const std::string bytes = ReadLogFrom(g.logPath, g.runOffset);
    if (bytes.empty()) return !g.url.empty();

    const std::wstring text = ToWide(bytes);
    std::wstring url;
    if (g.url.empty() && TakeAfterMarker(text, L"地址：", true, url)) g.url = url;
    std::wstring dir;
    if (g.logDir.empty() && TakeAfterMarker(text, L"日志：", false, dir)) g.logDir = dir;
    return !g.url.empty();
}

void KillClient() {
    if (g.job != nullptr) TerminateJobObject(g.job, 0);
    if (g.process != nullptr) {
        WaitForSingleObject(g.process, 5000);
        CloseHandle(g.process);
        g.process = nullptr;
    }
    if (g.job != nullptr) {
        CloseHandle(g.job); // KILL_ON_JOB_CLOSE 兜住可能漏掉的子进程
        g.job = nullptr;
    }
}

void OpenBrowser() {
    if (g.url.empty()) ParseBanner();
    const std::wstring target = g.url.empty() ? std::wstring(kDefaultUrl) : g.url;
    const HINSTANCE rc = ShellExecuteW(nullptr, L"open", target.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    if (reinterpret_cast<INT_PTR>(rc) <= 32) {
        MessageBoxW(g.hwnd, (L"打不开浏览器：\n" + target).c_str(), L"EhBrowser", MB_OK | MB_ICONWARNING);
    }
}

void OpenLogs() {
    if (g.logDir.empty()) ParseBanner();
    std::wstring target = NewestClientLog(g.logDir);
    if (target.empty()) target = g.logPath; // 客户端还没写出日志时退回启动器自己的日志
    const HINSTANCE rc = ShellExecuteW(nullptr, L"open", target.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    if (reinterpret_cast<INT_PTR>(rc) <= 32) {
        MessageBoxW(g.hwnd, (L"打不开日志：\n" + target).c_str(), L"EhBrowser", MB_OK | MB_ICONWARNING);
    }
}

/** 托盘图标：沿用 node.exe 的图标，与快捷方式保持一致；取不到就用系统默认 */
HICON LoadClientIcon() {
    wchar_t nodePath[MAX_PATH] = {};
    if (SearchPathW(nullptr, L"node.exe", nullptr, MAX_PATH, nodePath, nullptr) > 0) {
        HICON big = nullptr;
        HICON small = nullptr;
        if (ExtractIconExW(nodePath, 0, &big, &small, 1) > 0) {
            if (big != nullptr) DestroyIcon(big);
            if (small != nullptr) return small;
        }
    }
    return LoadIconW(nullptr, IDI_APPLICATION);
}

void UpdateTooltip() {
    if (!g.trayAdded) return;
    NOTIFYICONDATAW nid{};
    nid.cbSize = sizeof(nid);
    nid.hWnd = g.hwnd;
    nid.uID = kTrayId;
    nid.uFlags = NIF_TIP;
    const std::wstring tip = g.url.empty() ? std::wstring(L"EhBrowser（右键菜单）") : (L"EhBrowser\n" + g.url);
    lstrcpynW(nid.szTip, tip.c_str(), ARRAYSIZE(nid.szTip));
    Shell_NotifyIconW(NIM_MODIFY, &nid);
}

void AddTray() {
    if (g.trayAdded) return;
    if (g.icon == nullptr) g.icon = LoadClientIcon();

    NOTIFYICONDATAW nid{};
    nid.cbSize = sizeof(nid);
    nid.hWnd = g.hwnd;
    nid.uID = kTrayId;
    nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    nid.uCallbackMessage = WM_TRAY;
    nid.hIcon = g.icon;
    lstrcpynW(nid.szTip, L"EhBrowser（右键菜单）", ARRAYSIZE(nid.szTip));

    g.trayAdded = Shell_NotifyIconW(NIM_ADD, &nid) != 0;
    if (g.trayAdded) {
        UpdateTooltip();
    } else {
        // 通知区域加不上（资源管理器没在跑、或进程不在交互式会话里）不影响客户端本身
        LogLine(L"[启动器] 托盘图标没能加进通知区域");
    }
}

void RemoveTray() {
    if (!g.trayAdded) return;
    NOTIFYICONDATAW nid{};
    nid.cbSize = sizeof(nid);
    nid.hWnd = g.hwnd;
    nid.uID = kTrayId;
    Shell_NotifyIconW(NIM_DELETE, &nid);
    g.trayAdded = false;
}

void RequestQuit(UINT code) {
    RemoveTray();
    KillClient();
    PostQuitMessage(static_cast<int>(code));
}

void ShowMenu() {
    HMENU menu = CreatePopupMenu();
    if (menu == nullptr) return;
    AppendMenuW(menu, MF_STRING, kMenuOpen, L"打开浏览器");
    AppendMenuW(menu, MF_STRING, kMenuLogs, L"查看日志");
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_STRING, kMenuRestart, L"重启客户端");
    AppendMenuW(menu, MF_STRING, kMenuClose, L"关闭客户端");

    // 不抢前台，点到别处时菜单不会自己消失
    SetForegroundWindow(g.hwnd);
    POINT pt{};
    GetCursorPos(&pt);
    const UINT chosen = TrackPopupMenu(menu, TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY, pt.x, pt.y, 0, g.hwnd,
                                       nullptr);
    DestroyMenu(menu);
    PostMessageW(g.hwnd, WM_NULL, 0, 0);

    switch (chosen) {
        case kMenuOpen:
            OpenBrowser();
            break;
        case kMenuLogs:
            OpenLogs();
            break;
        case kMenuRestart: {
            LogLine(L"[启动器] 重启客户端");
            KillClient();
            Sleep(300); // 等端口彻底放开再起，免得新实例报「端口被占」
            const StartOutcome outcome = StartClient(true);
            if (outcome != StartOutcome::Running) {
                RequestQuit(outcome == StartOutcome::Failed ? 1 : 0);
                return;
            }
            ParseBanner();
            UpdateTooltip();
            break;
        }
        case kMenuClose:
            LogLine(L"[启动器] 关闭客户端");
            RequestQuit(0);
            break;
        default:
            break;
    }
}

LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (g.taskbarCreated != 0 && msg == g.taskbarCreated) {
        // 资源管理器重启过：图标要重新挂上去
        g.trayAdded = false;
        AddTray();
        return 0;
    }

    switch (msg) {
        case WM_TRAY:
            if (lp == WM_LBUTTONUP) {
                OpenBrowser();
            } else if (lp == WM_RBUTTONUP) {
                ShowMenu();
            }
            return 0;
        case WM_OPEN_BROWSER: // 第二个实例发现我们已经在了
            OpenBrowser();
            return 0;
        case WM_CLOSE:
            RequestQuit(0);
            return 0;
        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
        default:
            return DefWindowProcW(hwnd, msg, wp, lp);
    }
}

} // namespace

int WINAPI WinMain(HINSTANCE instance, HINSTANCE, LPSTR, int) {
    // 参数：先认自己的开关，其余全是要跑的命令（快捷方式给的是 ehbrowser）
    bool noTray = false;
    std::vector<std::wstring> args;
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (argv != nullptr) {
        for (int i = 1; i < argc; ++i) {
            const std::wstring arg = argv[i];
            if (i == 1 && arg == L"--no-tray") {
                noTray = true;
                continue;
            }
            args.push_back(arg);
        }
        LocalFree(argv);
    }
    if (args.empty()) args.push_back(kEntryName);

    g.command.clear();
    for (const std::wstring& a : args) {
        if (!g.command.empty()) g.command += L' ';
        g.command += ArgText(a);
    }

    // 入口名就是 ehbrowser 且同目录有 shim 时，优先用它（理由见 StartClient）
    const std::wstring entry = ToLowerAscii(args[0]);
    if (entry == kEntryName || entry == L"ehbrowser.cmd") {
        const std::wstring sibling = JoinPath(SelfDirectory(), kSiblingShim);
        if (FileExists(sibling)) g.siblingShim = sibling;
    }

    g.logPath = LogPath();
    g.taskbarCreated = RegisterWindowMessageW(L"TaskbarCreated");

    // 已经有实例在跑：请它把界面调出来就走，不能先起客户端（会撞端口）
    if (!noTray) {
        if (HWND existing = FindWindowW(kWindowClass, nullptr); existing != nullptr) {
            LogLine(L"[启动器] 已有实例在运行，请它打开浏览器");
            PostMessageW(existing, WM_OPEN_BROWSER, 0, 0);
            return 0;
        }
    }

    if (!noTray) {
        const WNDCLASSEXW wc = {sizeof(wc),    0,       WndProc, 0,          0, instance, nullptr, nullptr,
                                nullptr,       nullptr, kWindowClass, nullptr};
        if (RegisterClassExW(&wc) == 0) return 1;
        g.hwnd = CreateWindowExW(0, kWindowClass, L"EhBrowser", WS_POPUP, 0, 0, 0, 0, nullptr, nullptr, instance,
                                 nullptr);
        if (g.hwnd == nullptr) return 1;
    }

    const StartOutcome outcome = StartClient(!noTray);
    if (outcome != StartOutcome::Running) {
        KillClient();
        if (g.hwnd != nullptr) DestroyWindow(g.hwnd);
        return outcome == StartOutcome::Failed ? 1 : 0;
    }

    if (noTray) {
        // 诊断用：客户端留着跑，本程序退出（此时没有 job，不会把它带走）
        return 0;
    }

    LogLine(L"[启动器] 客户端已启动，托盘就绪");
    AddTray();
    ParseBanner();
    UpdateTooltip();

    // 消息循环：同时盯着客户端进程——它自己退了（界面里点了「关闭服务」或崩了）就收摊
    for (;;) {
        const DWORD wait = MsgWaitForMultipleObjects(1, &g.process, FALSE, INFINITE, QS_ALLINPUT);
        if (wait == WAIT_OBJECT_0) break; // 客户端结束

        MSG msg{};
        while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) {
                RequestQuit(static_cast<UINT>(msg.wParam));
                return static_cast<int>(msg.wParam);
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    LogLine(L"[启动器] 客户端已退出，收摊");
    RequestQuit(0);
    if (g.hwnd != nullptr) DestroyWindow(g.hwnd);
    return 0;
}
