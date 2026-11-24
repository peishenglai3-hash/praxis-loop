using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;

public static class PraxisAppContainerHost
{
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint TOKEN_QUERY = 0x0008;
    private const uint JOB_OBJECT_QUERY = 0x0004;
    private const uint JOB_OBJECT_TERMINATE = 0x0008;
    private const uint JOB_OBJECT_SET_ATTRIBUTES = 0x0002;
    private const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x0008;
    private const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x0100;
    private const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x0200;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
    private const uint PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint OPEN_EXISTING = 3;
    private const uint JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
    private const uint JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
    private const int TOKEN_IS_APPCONTAINER = 29;
    private const int ERROR_INSUFFICIENT_BUFFER = 122;
    private const int ERROR_ALREADY_EXISTS = 183;
    private static IntPtr activeJob = IntPtr.Zero;

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SID_AND_ATTRIBUTES
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_CAPABILITIES
    {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public uint CapabilityCount;
        public uint Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(string applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags,
        IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateJobObjectW(ref SECURITY_ATTRIBUTES attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, uint infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr job, uint infoClass, IntPtr info, uint length, IntPtr returnedLength);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int infoLength, out int returnLength);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, ref SECURITY_ATTRIBUTES attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ReadFile(IntPtr handle, byte[] buffer, uint bytesToRead, out uint bytesRead, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessHandleCount(IntPtr process, out uint handleCount);
    [DllImport("userenv.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern int CreateAppContainerProfile(string name, string displayName, string description, IntPtr capabilities, uint capabilityCount, out IntPtr sid);
    [DllImport("userenv.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("userenv.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern int DeleteAppContainerProfile(string name);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr stringSid);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool SetFileSecurityW(string path, uint information, IntPtr descriptor);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler handler, bool add);
    private delegate bool ConsoleCtrlHandler(uint controlType);

    private static int Main(string[] args)
    {
        try
        {
            if (Environment.GetEnvironmentVariable("PRAXIS_LOOP_FAKE_CODEX_MODE") == "1")
                return FakeCodex(args);
            if (args.Length == 1 && args[0] == "--check-current") return CheckCurrent(false, 0);
            if (args.Length == 2 && args[0] == "--process-stats") return CheckCurrent(true, UInt32.Parse(args[1]));
            if (args.Length == 10 && args[0] == "--run") return Run(args);
            Console.Error.WriteLine("Invalid AppContainer host invocation.");
            return 64;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }

    public static int RunFromPowerShell(string[] args)
    {
        if (args == null || args.Length != 10 || args[0] != "--run") throw new ArgumentException("Invalid host arguments.");
        return Run(args);
    }

    public static int DeleteProfileForPowerShell(string name)
    {
        return DeleteAppContainerProfile(name);
    }

    public static string CurrentProcessReport(uint parentPid, bool includeProcessStats)
    {
        IntPtr token = IntPtr.Zero;
        IntPtr value = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        IntPtr parent = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
            int needed;
            GetTokenInformation(token, TOKEN_IS_APPCONTAINER, IntPtr.Zero, 0, out needed);
            if (needed < 4) needed = 4;
            value = Marshal.AllocHGlobal(needed);
            if (!GetTokenInformation(token, TOKEN_IS_APPCONTAINER, value, needed, out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
            bool appContainer = Marshal.ReadInt32(value) != 0;
            string sid = appContainer ? AppContainerSidString(token) : "";
            string jobName = Environment.GetEnvironmentVariable("PRAXIS_LOOP_JOB_NAME") ?? "";
            if (String.IsNullOrWhiteSpace(jobName)) throw new InvalidOperationException("The named Job Object is not configured.");
            job = OpenJobObjectW(JOB_OBJECT_QUERY, false, jobName);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to open the evaluation Job Object.");
            bool inJob;
            if (!IsProcessInJob(GetCurrentProcess(), job, out inJob)) throw new Win32Exception(Marshal.GetLastWin32Error());
            uint active = QueryActiveProcesses(job);
            uint handles = 0;
            if (includeProcessStats)
            {
                parent = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, parentPid);
                if (parent == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to inspect the evaluator process handles.");
                if (!GetProcessHandleCount(parent, out handles)) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return "{\"appContainer\":" + (appContainer ? "true" : "false") +
                ",\"appContainerSid\":" + JsonString(sid) + ",\"inJob\":" + (inJob ? "true" : "false") +
                ",\"activeProcesses\":" + active + (includeProcessStats ? ",\"parentHandleCount\":" + handles : "") + "}";
        }
        finally
        {
            if (parent != IntPtr.Zero) CloseHandle(parent);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (value != IntPtr.Zero) Marshal.FreeHGlobal(value);
            if (token != IntPtr.Zero) CloseHandle(token);
        }
    }

    private static int FakeCodex(string[] args)
    {
        try
        {
            int outputIndex = Array.IndexOf(args, "--output-last-message");
            if (outputIndex < 0 || outputIndex + 1 >= args.Length) throw new InvalidOperationException("Codex fixture did not receive an output path.");
            string input;
            using (var reader = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8)) input = reader.ReadToEnd();
            var payload = "{\"args\":" + JsonArray(args) + ",\"input\":" + JsonString(input) + "}";
            File.WriteAllText(args[outputIndex + 1], payload, new UTF8Encoding(false));
            Console.Out.Write("offline diagnostic");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 2; }
    }

    private static int CheckCurrent(bool includeProcessStats, uint parentPid)
    {
        IntPtr token = IntPtr.Zero;
        IntPtr value = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        IntPtr parent = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
            int needed;
            GetTokenInformation(token, TOKEN_IS_APPCONTAINER, IntPtr.Zero, 0, out needed);
            if (needed < 4) needed = 4;
            value = Marshal.AllocHGlobal(needed);
            if (!GetTokenInformation(token, TOKEN_IS_APPCONTAINER, value, needed, out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
            bool appContainer = Marshal.ReadInt32(value) != 0;
            string sid = appContainer ? AppContainerSidString(token) : "";
            string jobName = Environment.GetEnvironmentVariable("PRAXIS_LOOP_JOB_NAME") ?? "";
            if (String.IsNullOrWhiteSpace(jobName)) throw new InvalidOperationException("The named Job Object is not configured.");
            job = OpenJobObjectW(JOB_OBJECT_QUERY, false, jobName);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to open the evaluation Job Object.");
            bool inJob;
            if (!IsProcessInJob(GetCurrentProcess(), job, out inJob)) throw new Win32Exception(Marshal.GetLastWin32Error());
            uint active = QueryActiveProcesses(job);
            uint handles = 0;
            if (includeProcessStats)
            {
                parent = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, parentPid);
                if (parent == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to inspect the evaluator process handles.");
                if (!GetProcessHandleCount(parent, out handles)) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            string json = "{\"appContainer\":" + (appContainer ? "true" : "false") +
                ",\"appContainerSid\":" + JsonString(sid) + ",\"inJob\":" + (inJob ? "true" : "false") +
                ",\"activeProcesses\":" + active + (includeProcessStats ? ",\"parentHandleCount\":" + handles : "") + "}";
            Console.Out.WriteLine(json);
            return appContainer && inJob ? 0 : 3;
        }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 4; }
        finally
        {
            if (parent != IntPtr.Zero) CloseHandle(parent);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (value != IntPtr.Zero) Marshal.FreeHGlobal(value);
            if (token != IntPtr.Zero) CloseHandle(token);
        }
    }

    private static string AppContainerSidString(IntPtr token)
    {
        const int TOKEN_APPCONTAINER_SID = 31;
        int needed;
        GetTokenInformation(token, TOKEN_APPCONTAINER_SID, IntPtr.Zero, 0, out needed);
        if (needed <= 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Token has no AppContainer SID.");
        IntPtr buffer = Marshal.AllocHGlobal(needed);
        try
        {
            if (!GetTokenInformation(token, TOKEN_APPCONTAINER_SID, buffer, needed, out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
            IntPtr sid = Marshal.ReadIntPtr(buffer);
            if (sid == IntPtr.Zero) throw new InvalidOperationException("Token has no AppContainer SID.");
            return SidString(sid);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static string SidString(IntPtr sid)
    {
        IntPtr text;
        if (!ConvertSidToStringSidW(sid, out text)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try { return Marshal.PtrToStringUni(text); }
        finally { LocalFree(text); }
    }

    private static uint QueryActiveProcesses(IntPtr job)
    {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(job, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION, buffer, (uint)size, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return ((JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(buffer, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION))).ActiveProcesses;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static bool SampleJobResources(IntPtr job, IntPtr process, string externalEvidence,
        string label, out string violation)
    {
        violation = null;
        uint handles;
        if (!GetProcessHandleCount(process, out handles)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to sample evaluator process handles.");
        uint active = QueryActiveProcesses(job);
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        ulong peakJobMemory;
        try
        {
            if (!QueryInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, buffer, (uint)size, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to sample Job Object memory usage.");
            var info = (JOBOBJECT_EXTENDED_LIMIT_INFORMATION)Marshal.PtrToStructure(buffer, typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            peakJobMemory = info.PeakJobMemoryUsed.ToUInt64();
        }
        finally { Marshal.FreeHGlobal(buffer); }
        string sample = "{\"timestamp\":" + JsonString(DateTime.UtcNow.ToString("o")) +
            ",\"activeProcesses\":" + active + ",\"evaluatorHandles\":" + handles +
            ",\"peakJobMemoryBytes\":" + peakJobMemory + "}" + Environment.NewLine;
        File.AppendAllText(Path.Combine(externalEvidence, label + ".resources.jsonl"), sample, new UTF8Encoding(false));
        if (handles > 512) violation = "evaluator-handles-exceeded-512";
        else if (active > 16) violation = "job-processes-exceeded-16";
        else if (peakJobMemory > 2UL * 1024UL * 1024UL * 1024UL) violation = "job-peak-memory-exceeded-2GiB";
        return violation == null;
    }

    private static int Run(string[] args)
    {
        string root = Path.GetFullPath(args[1]);
        string workspace = Path.GetFullPath(args[2]);
        string sandboxEvidence = Path.GetFullPath(args[3]);
        string profileName = args[4];
        string node = Path.GetFullPath(args[5]);
        string git = Path.GetFullPath(args[6]);
        string evaluator = Path.GetFullPath(args[7]);
        string mode = args[8];
        string externalEvidence = Path.GetFullPath(args[9]);
        Directory.CreateDirectory(externalEvidence);
        IntPtr appSid = IntPtr.Zero;
        TcpListener loopback = null;
        string sentinel = Path.Combine(externalEvidence, "host-only-sentinel.txt");
        string jobName = "Local\\PraxisLoop-" + Guid.NewGuid().ToString("N");
        try
        {
            int profileHr = CreateAppContainerProfile(profileName, "Praxis Loop Offline Test", "Temporary no-network test sandbox", IntPtr.Zero, 0, out appSid);
            if (profileHr != 0)
            {
                int win32 = profileHr & 0xffff;
                if (win32 != ERROR_ALREADY_EXISTS) Marshal.ThrowExceptionForHR(profileHr);
                int deriveHr = DeriveAppContainerSidFromAppContainerName(profileName, out appSid);
                if (deriveHr != 0) Marshal.ThrowExceptionForHR(deriveHr);
            }
            string appSidText = SidString(appSid);
            GrantSandboxAccess(root, appSidText);
            Directory.CreateDirectory(Path.Combine(root, "data", "tmp"));
            Directory.CreateDirectory(Path.Combine(root, "data", "home"));
            Directory.CreateDirectory(Path.Combine(root, "data", "state"));
            Directory.CreateDirectory(Path.Combine(root, "data", "home", "AppData", "Local", "Packages",
                profileName.ToLowerInvariant(), "AC", "Temp"));
            Directory.CreateDirectory(sandboxEvidence);
            File.WriteAllText(Path.Combine(root, "data", "home", "empty.gitconfig"), "", new UTF8Encoding(false));
            File.WriteAllText(sentinel, "host-only-sentinel-" + Guid.NewGuid().ToString("N"), new UTF8Encoding(false));
            ProtectFileForCurrentUser(sentinel);
            loopback = new TcpListener(IPAddress.Loopback, 0);
            loopback.Start();
            int loopbackPort = ((IPEndPoint)loopback.LocalEndpoint).Port;
            bool externalAvailable = CanConnectExternal();
            var preflightEnv = BuildEnvironment(root, workspace, sandboxEvidence, profileName, node, git,
                appSidText, jobName, loopbackPort, sentinel, externalAvailable);
            ChildResult startup = RunChild(root, workspace, profileName, appSid, jobName, node,
                new string[] { "-e", "process.stdout.write('node-appcontainer-started\\n')" }, preflightEnv,
                externalEvidence, "node-startup", 5000, 1024 * 1024);
            if (startup.ExitCode != 0 || startup.TimedOut || !startup.DescendantsClean)
                throw new InvalidOperationException("Node startup self-test failed in the AppContainer. exitCode=" + startup.ExitCode +
                    ", timedOut=" + startup.TimedOut + ", stdout=" + startup.Stdout + ", stderr=" + startup.Stderr);
            string preflightScript = Path.Combine(workspace, "scripts", "windows-sandbox-selftest.mjs");
            ChildResult preflight = RunChild(root, workspace, profileName, appSid, jobName, node,
                NodeBootstrapArgs(workspace, preflightScript, "preflight"), preflightEnv,
                externalEvidence, "preflight", 30000, 16 * 1024 * 1024);
            File.WriteAllText(Path.Combine(externalEvidence, "preflight.stdout.json"), preflight.Stdout, new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(externalEvidence, "preflight.stderr.log"), preflight.Stderr, new UTF8Encoding(false));
            if (preflight.ExitCode != 0 || preflight.TimedOut || !preflight.DescendantsClean)
                throw new InvalidOperationException("AppContainer security preflight failed; the offline test suite was not started. exitCode=" +
                    preflight.ExitCode + ", timedOut=" + preflight.TimedOut + ", descendantsClean=" + preflight.DescendantsClean +
                    ", stderr=" + preflight.Stderr + ", stdout=" + preflight.Stdout);
            VerifyTreeTermination(root, workspace, profileName, appSid, node, git, externalEvidence);

            if (mode == "preflight-only")
            {
                var preflightRecord = "{\"schemaVersion\":1,\"mode\":\"preflight-only\",\"status\":\"passed\"" +
                    ",\"isolation\":\"Windows AppContainer with no network capabilities and a kill-on-close Job Object\"" +
                    ",\"appContainerSid\":" + JsonString(appSidText) + ",\"noNetworkCapabilities\":true" +
                    ",\"externalNetworkHostBaseline\":" + (externalAvailable ? "true" : "false") +
                    ",\"processExitCode\":0,\"timedOut\":false,\"descendantsClean\":true}";
                File.WriteAllText(Path.Combine(externalEvidence, "host-manifest.json"), preflightRecord, new UTF8Encoding(false));
                Console.Out.WriteLine(preflightRecord);
                return 0;
            }

            string mainJobName = "Local\\PraxisLoop-" + Guid.NewGuid().ToString("N");
            var mainEnv = BuildEnvironment(root, workspace, sandboxEvidence, profileName, node, git,
                appSidText, mainJobName, 0, sentinel, false);
            ChildResult result = RunChild(root, workspace, profileName, appSid, mainJobName, node,
                NodeBootstrapArgs(workspace, evaluator, mode), mainEnv, externalEvidence, mode, ModeTimeout(mode), 64 * 1024 * 1024);
            File.WriteAllText(Path.Combine(externalEvidence, "appcontainer.stdout.log"), result.Stdout, new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(externalEvidence, "appcontainer.stderr.log"), result.Stderr, new UTF8Encoding(false));
            var hostRecord = "{\"schemaVersion\":1,\"mode\":" + JsonString(mode) +
                ",\"isolation\":\"Windows AppContainer with no network capabilities and a kill-on-close Job Object\"" +
                ",\"appContainerSid\":" + JsonString(appSidText) + ",\"noNetworkCapabilities\":true" +
                ",\"jobName\":" + JsonString(mainJobName) + ",\"externalNetworkHostBaseline\":" + (externalAvailable ? "true" : "false") +
                ",\"processExitCode\":" + result.ExitCode + ",\"timedOut\":" + (result.TimedOut ? "true" : "false") +
                ",\"descendantsClean\":" + (result.DescendantsClean ? "true" : "false") + "}";
            File.WriteAllText(Path.Combine(externalEvidence, "host-manifest.json"), hostRecord, new UTF8Encoding(false));
            if (result.ExitCode != 0 || result.TimedOut || !result.DescendantsClean) return 5;
            Console.Out.WriteLine(hostRecord);
            return 0;
        }
        finally
        {
            if (activeJob != IntPtr.Zero) { TerminateJobObject(activeJob, 125); CloseHandle(activeJob); activeJob = IntPtr.Zero; }
            if (loopback != null) loopback.Stop();
            try { if (File.Exists(sentinel)) File.Delete(sentinel); } catch { }
            if (appSid != IntPtr.Zero) FreeSid(appSid);
            DeleteAppContainerProfile(profileName);
        }
    }

    private sealed class ChildResult
    {
        public int ExitCode;
        public bool TimedOut;
        public bool DescendantsClean;
        public string Stdout;
        public string Stderr;
    }

    private static uint ModeTimeout(string mode)
    {
        if (mode == "mechanism") return 30U * 60U * 1000U;
        return 2U * 60U * 60U * 1000U;
    }

    private static string[] NodeBootstrapArgs(string workspace, string entry, string mode)
    {
        string bootstrap = File.ReadAllText(Path.Combine(workspace, "scripts", "windows-loader-bootstrap.cjs"));
        return new string[] { "-e", bootstrap, "--", entry, mode };
    }

    private static Dictionary<string, string> BuildEnvironment(string root, string workspace, string evidence,
        string profileName, string node, string git, string appSid, string jobName, int loopbackPort,
        string sentinel, bool externalAvailable)
    {
        string data = Path.Combine(root, "data");
        string systemRoot = Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows";
        string system32 = Path.Combine(systemRoot, "System32");
        string home = Path.Combine(data, "home");
        string local = Path.Combine(home, "AppData", "Local");
        string roaming = Path.Combine(home, "AppData", "Roaming");
        string tmp = Path.Combine(data, "tmp");
        Directory.CreateDirectory(local);
        Directory.CreateDirectory(roaming);
        return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
            { "SystemRoot", systemRoot }, { "WINDIR", systemRoot }, { "SystemDrive", Path.GetPathRoot(systemRoot).TrimEnd('\\') },
            { "PROCESSOR_ARCHITECTURE", Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") ?? "AMD64" },
            { "OS", "Windows_NT" }, { "PATH", Path.GetDirectoryName(node) + ";" + Path.GetDirectoryName(git) + ";" + system32 },
            { "PATHEXT", ".EXE" }, { "NODE_OPTIONS", "--preserve-symlinks --preserve-symlinks-main" },
            { "TEMP", tmp }, { "TMP", tmp }, { "USERPROFILE", home }, { "HOME", home },
            { "APPDATA", roaming }, { "LOCALAPPDATA", local },
            { "XDG_CONFIG_HOME", Path.Combine(home, ".config") }, { "XDG_STATE_HOME", Path.Combine(home, ".state") },
            { "PRAXIS_LOOP_STATE_DIR", Path.Combine(data, "state") }, { "PRAXIS_LOOP_EVIDENCE_DIR", evidence },
            { "PRAXIS_LOOP_SANDBOX_ROOT", root }, { "PRAXIS_LOOP_APPCONTAINER_NAME", profileName },
            { "PRAXIS_LOOP_APPCONTAINER_SID", appSid }, { "PRAXIS_LOOP_APPCONTAINER_VERIFIED", "1" },
            { "PRAXIS_LOOP_JOB_OBJECT_VERIFIED", "1" }, { "PRAXIS_LOOP_SANDBOX_VERIFIED", "1" },
            { "PRAXIS_LOOP_HOST_SOURCE", Path.Combine(root, "tools", "windows-appcontainer-host.cs") },
            { "PRAXIS_LOOP_JOB_NAME", jobName },
            { "PRAXIS_LOOP_LOOPBACK_PORT", loopbackPort.ToString() }, { "PRAXIS_LOOP_SENTINEL", sentinel },
            { "PRAXIS_LOOP_EXTERNAL_PROBE", externalAvailable ? "1" : "0" }, { "PRAXIS_LOOP_NO_NETWORK_CAPABILITIES", "1" },
            { "PRAXIS_LOOP_GIT_EXE", git }, { "GIT_CONFIG_NOSYSTEM", "1" },
            { "GIT_CONFIG_GLOBAL", Path.Combine(home, "empty.gitconfig") }
        };
    }

    private static ChildResult RunChild(string root, string workspace, string profileName, IntPtr appSid,
        string jobName, string executable, string[] args, Dictionary<string, string> environment,
        string externalEvidence, string label, uint timeoutMs, int maxOutput)
    {
        IntPtr job = CreateJob(jobName, appSid);
        activeJob = job;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        IntPtr attributeList = IntPtr.Zero;
        IntPtr attributeStorage = IntPtr.Zero;
        IntPtr outRead = IntPtr.Zero, outWrite = IntPtr.Zero, errRead = IntPtr.Zero, errWrite = IntPtr.Zero;
        IntPtr stdin = IntPtr.Zero;
        var output = new BoundedCapture(maxOutput, job);
        var error = new BoundedCapture(maxOutput, job);
        Thread outThread = null, errThread = null;
        bool descendantsClean = true;
        bool timedOut = false;
        bool resourceLimitExceeded = false;
        string resourceViolation = null;
        bool resumed = false;
        try
        {
            SECURITY_ATTRIBUTES pipeAttributes = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = true };
            if (!CreatePipe(out outRead, out outWrite, ref pipeAttributes, 0) || !CreatePipe(out errRead, out errWrite, ref pipeAttributes, 0))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to create child output pipes.");
            SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0);
            SetHandleInformation(errRead, HANDLE_FLAG_INHERIT, 0);
            stdin = CreateFileW("NUL", GENERIC_READ, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
            if (stdin == IntPtr.Zero || stdin == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to open NUL for child stdin.");
            if (!SetHandleInformation(stdin, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to mark child stdin inheritable.");

            IntPtr sidText = IntPtr.Zero;
            if (!ConvertSidToStringSidW(appSid, out sidText)) throw new Win32Exception(Marshal.GetLastWin32Error());
            string sidString;
            try { sidString = Marshal.PtrToStringUni(sidText); } finally { LocalFree(sidText); }
            string envBlock = EnvironmentBlock(environment);
            IntPtr env = Marshal.StringToHGlobalUni(envBlock);
            IntPtr capabilityPtr = IntPtr.Zero;
            IntPtr handles = IntPtr.Zero;
            try
            {
                IntPtr size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
                int lastError = Marshal.GetLastWin32Error();
                if (size == IntPtr.Zero || (lastError != ERROR_INSUFFICIENT_BUFFER && lastError != 0))
                    throw new Win32Exception(lastError, "Unable to size the process attribute list.");
                attributeStorage = Marshal.AllocHGlobal(size);
                if (!InitializeProcThreadAttributeList(attributeStorage, 2, 0, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
                attributeList = attributeStorage;
                var capabilities = new SECURITY_CAPABILITIES { AppContainerSid = appSid, Capabilities = IntPtr.Zero, CapabilityCount = 0, Reserved = 0 };
                capabilityPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
                handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.StructureToPtr(capabilities, capabilityPtr, false);
                if (!UpdateProcThreadAttribute(attributeList, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES), capabilityPtr,
                    new IntPtr(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES))), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
                Marshal.WriteIntPtr(handles, 0, stdin);
                Marshal.WriteIntPtr(handles, IntPtr.Size, outWrite);
                Marshal.WriteIntPtr(handles, IntPtr.Size * 2, errWrite);
                if (!UpdateProcThreadAttribute(attributeList, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), handles,
                    new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());

                var startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = stdin;
                startup.StartupInfo.hStdOutput = outWrite;
                startup.StartupInfo.hStdError = errWrite;
                startup.lpAttributeList = attributeList;
                string commandLine = QuoteArgument(executable) + " " + String.Join(" ", args.Select(QuoteArgument));
                var mutableCommandLine = new StringBuilder(commandLine);
                if (!CreateProcessW(executable, mutableCommandLine, IntPtr.Zero, IntPtr.Zero, true,
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                    env, workspace, ref startup, out process)) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed for the AppContainer child.");
            }
            finally
            {
                if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
                if (capabilityPtr != IntPtr.Zero) Marshal.FreeHGlobal(capabilityPtr);
                Marshal.FreeHGlobal(env);
            }

            CloseHandle(outWrite); outWrite = IntPtr.Zero;
            CloseHandle(errWrite); errWrite = IntPtr.Zero;
            if (!AssignProcessToJobObject(job, process.hProcess)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to assign the suspended child to its kill-on-close Job Object.");
            bool inJob;
            if (!IsProcessInJob(process.hProcess, job, out inJob) || !inJob) throw new InvalidOperationException("The suspended child was not assigned to its kill-on-close Job Object.");
            if (!IsAppContainerProcess(process.hProcess, appSid)) throw new InvalidOperationException("The suspended child token is not the expected AppContainer.");
            outThread = new Thread(() => Drain(outRead, output)); outThread.IsBackground = true; outThread.Start();
            errThread = new Thread(() => Drain(errRead, error)); errThread.IsBackground = true; errThread.Start();
            uint previousSuspendCount = ResumeThread(process.hThread);
            if (previousSuspendCount == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to resume the AppContainer process.");
            if (previousSuspendCount == 0) throw new InvalidOperationException("CreateProcess returned an unsuspended AppContainer thread; refusing to continue.");
            resumed = true;
            var elapsed = Stopwatch.StartNew();
            uint wait;
            while (true)
            {
                long remaining = (long)timeoutMs - elapsed.ElapsedMilliseconds;
                uint waitMs = (uint)Math.Min(1000L, Math.Max(1L, remaining));
                wait = WaitForSingleObject(process.hProcess, waitMs);
                if (wait == 0) break;
                if (wait != 0x00000102) throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject failed for the AppContainer process.");
                if (elapsed.ElapsedMilliseconds >= timeoutMs)
                {
                    timedOut = true;
                    TerminateJobObject(job, 124);
                    WaitForSingleObject(process.hProcess, 10000);
                    break;
                }
                if (!SampleJobResources(job, process.hProcess, externalEvidence, label, out resourceViolation))
                {
                    resourceLimitExceeded = true;
                    TerminateJobObject(job, 127);
                    WaitForSingleObject(process.hProcess, 10000);
                    break;
                }
            }

            if (!timedOut && !output.Exceeded && !error.Exceeded)
            {
                DateTime deadline = DateTime.UtcNow.AddSeconds(3);
                while (QueryActiveProcesses(job) != 0 && DateTime.UtcNow < deadline) Thread.Sleep(50);
                if (QueryActiveProcesses(job) != 0)
                {
                    descendantsClean = false;
                    TerminateJobObject(job, 125);
                }
            }
            if (output.Exceeded || error.Exceeded) TerminateJobObject(job, 126);
            if (timedOut || output.Exceeded || error.Exceeded) descendantsClean = QueryActiveProcesses(job) == 0;
            if (outThread != null) outThread.Join(5000);
            if (errThread != null) errThread.Join(5000);
            uint exit;
            GetExitCodeProcess(process.hProcess, out exit);
            var result = new ChildResult { ExitCode = output.Exceeded || error.Exceeded ? 126 : resourceLimitExceeded ? 127 : unchecked((int)exit),
                TimedOut = timedOut, DescendantsClean = descendantsClean, Stdout = output.Text, Stderr = error.Text };
            if (resourceLimitExceeded)
                File.AppendAllText(Path.Combine(externalEvidence, label + ".resources.jsonl"),
                    "{\"violation\":" + JsonString(resourceViolation) + "}" + Environment.NewLine, new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(externalEvidence, label + ".stdout.log"), result.Stdout, new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(externalEvidence, label + ".stderr.log"), result.Stderr, new UTF8Encoding(false));
            return result;
        }
        finally
        {
            if (process.hProcess != IntPtr.Zero && !resumed) TerminateProcess(process.hProcess, 125);
            if (QueryActiveSafely(job) > 0) TerminateJobObject(job, 125);
            if (attributeList != IntPtr.Zero) DeleteProcThreadAttributeList(attributeList);
            if (attributeStorage != IntPtr.Zero) Marshal.FreeHGlobal(attributeStorage);
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (outRead != IntPtr.Zero) CloseHandle(outRead);
            if (outWrite != IntPtr.Zero) CloseHandle(outWrite);
            if (errRead != IntPtr.Zero) CloseHandle(errRead);
            if (errWrite != IntPtr.Zero) CloseHandle(errWrite);
            if (stdin != IntPtr.Zero && stdin != new IntPtr(-1)) CloseHandle(stdin);
            CloseHandle(job);
            activeJob = IntPtr.Zero;
        }
    }

    private sealed class BoundedCapture
    {
        private readonly object gate = new object();
        private readonly MemoryStream stream = new MemoryStream();
        private readonly int maximum;
        private readonly IntPtr job;
        private int total;
        public bool Exceeded;
        public BoundedCapture(int maximum, IntPtr job) { this.maximum = maximum; this.job = job; }
        public void Add(byte[] bytes, int count)
        {
            lock (gate)
            {
                if (total + count > maximum)
                {
                    Exceeded = true;
                    TerminateJobObject(job, 126);
                    return;
                }
                total += count;
                stream.Write(bytes, 0, count);
            }
        }
        public string Text { get { lock (gate) return Encoding.UTF8.GetString(stream.ToArray()); } }
    }

    private static void Drain(IntPtr pipe, BoundedCapture capture)
    {
        byte[] buffer = new byte[65536];
        while (true)
        {
            uint read;
            bool ok = ReadFile(pipe, buffer, (uint)buffer.Length, out read, IntPtr.Zero);
            if (!ok || read == 0) break;
            capture.Add(buffer, (int)read);
        }
    }

    private static IntPtr CreateJob(string name, IntPtr appSid)
    {
        IntPtr sidText = IntPtr.Zero;
        if (!ConvertSidToStringSidW(appSid, out sidText)) throw new Win32Exception(Marshal.GetLastWin32Error());
        string sid;
        try { sid = Marshal.PtrToStringUni(sidText); } finally { LocalFree(sidText); }
        IntPtr descriptor;
        uint descriptorBytes;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;0x0004;;;" + sid + ")", 1, out descriptor, out descriptorBytes))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to create Job Object query ACL.");
        try
        {
            var attributes = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), lpSecurityDescriptor = descriptor, bInheritHandle = false };
            IntPtr job = CreateJobObjectW(ref attributes, name);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to create the evaluation Job Object.");
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
                JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY;
            limits.BasicLimitInformation.ActiveProcessLimit = 16;
            limits.ProcessMemoryLimit = new UIntPtr(1024UL * 1024UL * 1024UL);
            limits.JobMemoryLimit = new UIntPtr(2UL * 1024UL * 1024UL * 1024UL);
            IntPtr data = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
            try
            {
                Marshal.StructureToPtr(limits, data, false);
                if (!SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, data, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                { CloseHandle(job); throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to set Job Object limits."); }
            }
            finally { Marshal.FreeHGlobal(data); }
            return job;
        }
        finally { LocalFree(descriptor); }
    }

    private static bool IsAppContainerProcess(IntPtr process, IntPtr expectedSid)
    {
        IntPtr token;
        if (!OpenProcessToken(process, TOKEN_QUERY, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr buffer = IntPtr.Zero;
        try
        {
            int needed;
            GetTokenInformation(token, TOKEN_IS_APPCONTAINER, IntPtr.Zero, 0, out needed);
            if (needed < 4) needed = 4;
            buffer = Marshal.AllocHGlobal(needed);
            if (!GetTokenInformation(token, TOKEN_IS_APPCONTAINER, buffer, needed, out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (Marshal.ReadInt32(buffer) == 0) return false;
            return String.Equals(AppContainerSidString(token), SidString(expectedSid), StringComparison.OrdinalIgnoreCase);
        }
        finally { if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer); CloseHandle(token); }
    }

    private static void GrantSandboxAccess(string path, string sid)
    {
        string icacls = Path.Combine(Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows", "System32", "icacls.exe");
        var start = new ProcessStartInfo { FileName = icacls, Arguments = QuoteArgument(path) + " /grant *" + sid + ":(OI)(CI)M /T /C",
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        using (Process process = Process.Start(start))
        {
            string stdout = process.StandardOutput.ReadToEnd();
            string stderr = process.StandardError.ReadToEnd();
            process.WaitForExit();
            if (process.ExitCode != 0) throw new InvalidOperationException("Unable to grant the temporary sandbox ACL: " + stderr + stdout);
        }
    }

    private static void ProtectFileForCurrentUser(string path)
    {
        string userSid = WindowsIdentity.GetCurrent().User.Value;
        IntPtr descriptor;
        uint bytes;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;FA;;;" + userSid + ")", 1, out descriptor, out bytes))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to protect the host-only sentinel.");
        try
        {
            const uint DACL_SECURITY_INFORMATION = 0x00000004;
            const uint PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
            if (!SetFileSecurityW(path, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, descriptor))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to set the host-only sentinel ACL.");
        }
        finally { LocalFree(descriptor); }
    }

    private static string EnvironmentBlock(Dictionary<string, string> variables)
    {
        var text = new StringBuilder();
        foreach (var item in variables.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase))
            text.Append(item.Key).Append('=').Append(item.Value).Append('\0');
        text.Append('\0');
        return text.ToString();
    }

    private static string QuoteArgument(string argument)
    {
        if (argument.Length > 0 && !argument.Any(c => Char.IsWhiteSpace(c) || c == '"')) return argument;
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in argument)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1).Append('"'); slashes = 0; continue; }
            result.Append('\\', slashes).Append(c); slashes = 0;
        }
        result.Append('\\', slashes * 2).Append('"');
        return result.ToString();
    }

    private static uint QueryActiveSafely(IntPtr job)
    {
        if (job == IntPtr.Zero) return 0;
        try { return QueryActiveProcesses(job); } catch { return 0; }
    }

    private static bool CanConnectExternal()
    {
        try
        {
            using (var client = new TcpClient())
            {
                IAsyncResult result = client.BeginConnect(IPAddress.Parse("1.1.1.1"), 443, null, null);
                bool connected = result.AsyncWaitHandle.WaitOne(1500);
                if (!connected) return false;
                client.EndConnect(result);
                return client.Connected;
            }
        }
        catch { return false; }
    }

    private static void VerifyTreeTermination(string root, string workspace, string profileName, IntPtr appSid,
        string node, string git, string externalEvidence)
    {
        string data = Path.Combine(root, "data");
        string parentPath = Path.Combine(data, "tree-parent.pid");
        string childPath = Path.Combine(data, "tree-child.pid");
        string grandchildPath = Path.Combine(data, "tree-grandchild.pid");
        string treeScript = Path.Combine(workspace, "scripts", "windows-tree-selftest.mjs");
        string name = "Local\\PraxisLoop-Tree-" + Guid.NewGuid().ToString("N");
        IntPtr job = CreateJob(name, appSid);
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool resumed = false;
        try
        {
            var environment = BuildEnvironment(root, workspace, Path.Combine(root, "evidence"), profileName, node, git,
                SidString(appSid), name, 0, "", false);
            environment["PARENT"] = parentPath; environment["CHILD"] = childPath; environment["GRAND"] = grandchildPath;
            var startup = CreateSuspendedAppContainerProcess(node, NodeBootstrapArgs(workspace, treeScript, "tree-selftest"), workspace, environment, appSid, out process);
            try
            {
                bool inJob;
                if (!IsAppContainerProcess(process.hProcess, appSid))
                    throw new InvalidOperationException("The descendant cleanup self-test process did not enter the expected AppContainer.");
                if (!AssignProcessToJobObject(job, process.hProcess)) throw new Win32Exception(Marshal.GetLastWin32Error());
                // Assignment is verified again after assignment; all members inherit the Job Object.
                if (!IsProcessInJob(process.hProcess, job, out inJob) || !inJob)
                    throw new InvalidOperationException("The descendant cleanup self-test process was not assigned to its Job Object.");
                uint previousSuspendCount = ResumeThread(process.hThread);
                if (previousSuspendCount == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to resume descendant cleanup self-test process.");
                if (previousSuspendCount == 0) throw new InvalidOperationException("CreateProcess returned an unsuspended descendant cleanup process.");
                resumed = true;
                DateTime readyDeadline = DateTime.UtcNow.AddSeconds(10);
                while (DateTime.UtcNow < readyDeadline && !(File.Exists(parentPath) && File.Exists(childPath) && File.Exists(grandchildPath))) Thread.Sleep(25);
                if (!(File.Exists(parentPath) && File.Exists(childPath) && File.Exists(grandchildPath)))
                    throw new InvalidOperationException("Descendant cleanup self-test did not create all process markers.");
                WaitForSingleObject(process.hProcess, 10000);
                uint active = QueryActiveProcesses(job);
                if (active < 2) throw new InvalidOperationException("The Job Object did not retain the expected child and grandchild after their parent exited.");
                CloseHandle(job);
                job = IntPtr.Zero;
                uint[] pids = new uint[] { UInt32.Parse(File.ReadAllText(childPath)), UInt32.Parse(File.ReadAllText(grandchildPath)) };
                foreach (uint pid in pids)
                {
                    IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | 0x00100000, false, pid);
                    if (handle != IntPtr.Zero)
                    {
                        uint wait = WaitForSingleObject(handle, 0);
                        CloseHandle(handle);
                        if (wait != 0) throw new InvalidOperationException("Closing the Job Object did not terminate every descendant.");
                    }
                }
                File.WriteAllText(Path.Combine(externalEvidence, "tree-cleanup.json"), "{\"status\":\"passed\",\"activeProcessesBeforeClose\":" + active + ",\"descendantPids\":[" + String.Join(",", pids) + "]}", new UTF8Encoding(false));
            }
            finally { if (startup.lpAttributeList != IntPtr.Zero) DeleteProcThreadAttributeList(startup.lpAttributeList); Marshal.FreeHGlobal(startup.lpAttributeList); }
        }
        finally
        {
            if (job != IntPtr.Zero) { TerminateJobObject(job, 125); CloseHandle(job); }
            if (process.hProcess != IntPtr.Zero && !resumed) TerminateProcess(process.hProcess, 125);
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
        }
    }

    private static STARTUPINFOEX CreateSuspendedAppContainerProcess(string executable, string[] args, string cwd,
        Dictionary<string, string> environment, IntPtr appSid, out PROCESS_INFORMATION process)
    {
        process = new PROCESS_INFORMATION();
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        IntPtr list = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var capabilities = new SECURITY_CAPABILITIES { AppContainerSid = appSid, Capabilities = IntPtr.Zero, CapabilityCount = 0, Reserved = 0 };
            IntPtr capPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
            try
            {
                Marshal.StructureToPtr(capabilities, capPtr, false);
                if (!UpdateProcThreadAttribute(list, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES), capPtr,
                    new IntPtr(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES))), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
                IntPtr env = Marshal.StringToHGlobalUni(EnvironmentBlock(environment));
                try
                {
                var startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.lpAttributeList = list;
                string cmd = QuoteArgument(executable) + " " + String.Join(" ", args.Select(QuoteArgument));
                if (!CreateProcessW(executable, new StringBuilder(cmd), IntPtr.Zero, IntPtr.Zero, false,
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                    env, cwd, ref startup, out process)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to create descendant cleanup fixture.");
                return startup;
                }
                finally { Marshal.FreeHGlobal(env); }
            }
            finally { Marshal.FreeHGlobal(capPtr); }
        }
        catch { DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); throw; }
    }

    private static string JsonString(string value)
    {
        if (value == null) return "null";
        var result = new StringBuilder("\"");
        foreach (char c in value)
        {
            switch (c)
            {
                case '\\': result.Append("\\\\"); break;
                case '"': result.Append("\\\""); break;
                case '\n': result.Append("\\n"); break;
                case '\r': result.Append("\\r"); break;
                case '\t': result.Append("\\t"); break;
                default: if (c < 0x20) result.Append("\\u").Append(((int)c).ToString("x4")); else result.Append(c); break;
            }
        }
        return result.Append('"').ToString();
    }

    private static string JsonArray(IEnumerable<string> values) { return "[" + String.Join(",", values.Select(JsonString)) + "]"; }
}
