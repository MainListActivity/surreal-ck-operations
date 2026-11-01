/*
 * ps for employee sandbox sessions. /bin/ps is setuid root, and a process inside a Seatbelt sandbox may not execute
 * a setuid binary ("Operation not permitted"). Factory's Execute supervisor checks its owner with
 * `ps -o ppid= -p $$` every two seconds and kills the command's process group the moment that check fails, so in the
 * sandbox every foreground command died within milliseconds. launch.sh puts this binary first on PATH for company
 * sessions; it reads the same facts through libproc, which needs no privilege for the user's own processes.
 *
 * Supported: -A -e -a -x (all visible processes), -p <pids>, -g <pgids>, -o <fields> (repeatable; a trailing `=`
 * on a field drops its header), and -ww. Fields: pid ppid pgid stat state lstart etime comm ucomm command args uid
 * user rss. Without -o the columns are PID and COMMAND. Exit status is 1 when -p/-g matched nothing, like ps.
 */
#include <libproc.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <time.h>
#include <unistd.h>

#define MAX_FIELDS 32
#define MAX_IDS 256

struct field { char name[32]; char header[64]; };
static struct field fields[MAX_FIELDS];
static int nfields;
static int pids[MAX_IDS], npids;
static int pgids[MAX_IDS], npgids;
static int all;

static int usage(const char *why) {
  fprintf(stderr, "ps (sck sandbox): %s\n", why);
  return 1;
}

/* strtok writes into its input; argv is the process's visible command line, so parse a copy. */
static int add_fields(const char *arg) {
  char *spec = strdup(arg);
  if (!spec) return usage("out of memory");
  for (char *tok = strtok(spec, ", "); tok; tok = strtok(NULL, ", ")) {
    if (nfields == MAX_FIELDS) return usage("too many -o fields");
    struct field *f = &fields[nfields++];
    char *eq = strchr(tok, '=');
    if (eq) { *eq = 0; snprintf(f->header, sizeof f->header, "%s", eq + 1); }
    else {
      snprintf(f->header, sizeof f->header, "%s", tok);
      for (char *c = f->header; *c; c++) if (*c >= 'a' && *c <= 'z') *c -= 32;
    }
    snprintf(f->name, sizeof f->name, "%s", tok);
  }
  return 0;
}

static int add_ids(const char *arg, int *ids, int *n) {
  char *spec = strdup(arg);
  if (!spec) return usage("out of memory");
  for (char *tok = strtok(spec, ", "); tok; tok = strtok(NULL, ", ")) {
    if (*n == MAX_IDS) return usage("too many ids");
    char *end;
    long v = strtol(tok, &end, 10);
    if (*end || v < 0) return usage("bad process id");
    ids[(*n)++] = (int)v;
  }
  return 0;
}

/* Full argument vector from KERN_PROCARGS2; falls back to the short name when the kernel withholds it. */
static void args_of(int pid, const char *fallback, char *out, size_t size) {
  int mib[3] = { CTL_KERN, KERN_PROCARGS2, pid };
  size_t len = 0;
  snprintf(out, size, "%s", fallback);
  if (sysctl(mib, 3, NULL, &len, NULL, 0) != 0 || len < sizeof(int)) return;
  char *buf = malloc(len);
  if (!buf) return;
  if (sysctl(mib, 3, buf, &len, NULL, 0) != 0) { free(buf); return; }
  int argc;
  memcpy(&argc, buf, sizeof argc);
  char *p = buf + sizeof argc, *end = buf + len;
  while (p < end && *p) p++;          /* executable path */
  while (p < end && !*p) p++;         /* padding */
  size_t used = 0;
  out[0] = 0;
  for (int i = 0; i < argc && p < end; i++) {
    size_t n = strnlen(p, (size_t)(end - p));
    if (used + n + 2 >= size) break;
    if (used) out[used++] = ' ';
    memcpy(out + used, p, n);
    used += n;
    out[used] = 0;
    p += n + 1;
  }
  if (!used) snprintf(out, size, "%s", fallback);
  free(buf);
}

static const char *state_of(const struct proc_bsdinfo *b) {
  switch (b->pbi_status) {
    case SIDL: return "I";
    case SRUN: return "R";
    case SSLEEP: return "S";
    case SSTOP: return "T";
    case SZOMB: return "Z";
    default: return "?";
  }
}

static void print_field(const char *name, int pid, const struct proc_bsdinfo *b, int last) {
  char buf[8192];
  if (!strcmp(name, "pid")) snprintf(buf, sizeof buf, "%d", pid);
  else if (!strcmp(name, "ppid")) snprintf(buf, sizeof buf, "%u", b->pbi_ppid);
  else if (!strcmp(name, "pgid")) snprintf(buf, sizeof buf, "%u", b->pbi_pgid);
  else if (!strcmp(name, "stat") || !strcmp(name, "state")) snprintf(buf, sizeof buf, "%s", state_of(b));
  else if (!strcmp(name, "uid")) snprintf(buf, sizeof buf, "%u", b->pbi_uid);
  else if (!strcmp(name, "user")) {
    struct passwd *pw = getpwuid(b->pbi_uid);
    snprintf(buf, sizeof buf, "%s", pw ? pw->pw_name : "?");
  } else if (!strcmp(name, "lstart")) {
    time_t t = (time_t)b->pbi_start_tvsec;
    struct tm tm;
    localtime_r(&t, &tm);
    strftime(buf, sizeof buf, "%a %b %e %H:%M:%S %Y", &tm);
  } else if (!strcmp(name, "etime")) {
    long s = (long)(time(NULL) - (time_t)b->pbi_start_tvsec);
    if (s < 0) s = 0;
    long d = s / 86400, h = s / 3600 % 24, m = s / 60 % 60, sec = s % 60;
    if (d) snprintf(buf, sizeof buf, "%ld-%02ld:%02ld:%02ld", d, h, m, sec);
    else if (h) snprintf(buf, sizeof buf, "%02ld:%02ld:%02ld", h, m, sec);
    else snprintf(buf, sizeof buf, "%02ld:%02ld", m, sec);
  } else if (!strcmp(name, "rss")) {
    struct proc_taskinfo ti;
    if (proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &ti, sizeof ti) == (int)sizeof ti)
      snprintf(buf, sizeof buf, "%llu", (unsigned long long)(ti.pti_resident_size / 1024));
    else snprintf(buf, sizeof buf, "0");
  } else if (!strcmp(name, "comm") || !strcmp(name, "ucomm")) snprintf(buf, sizeof buf, "%s", b->pbi_comm);
  else if (!strcmp(name, "command") || !strcmp(name, "args")) args_of(pid, b->pbi_comm, buf, sizeof buf);
  else snprintf(buf, sizeof buf, "-");
  fputs(buf, stdout);
  fputs(last ? "\n" : " ", stdout);
}

static int wanted(int pid, const struct proc_bsdinfo *b) {
  if (all) return 1;
  for (int i = 0; i < npids; i++) if (pids[i] == pid) return 1;
  for (int i = 0; i < npgids; i++) if (pgids[i] == (int)b->pbi_pgid) return 1;
  /* No selector: the caller's own processes, as ps does by default. */
  return !npids && !npgids && b->pbi_uid == getuid();
}

int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) {
    char *a = argv[i];
    if (a[0] != '-') {
      /* BSD style: `ps ax`, `ps axo pid=`. */
      if (strchr(a, 'a') || strchr(a, 'x')) all = 1;
      if (strchr(a, 'o') && i + 1 < argc && add_fields(argv[++i])) return 1;
      continue;
    }
    for (char *c = a + 1; *c; c++) {
      if (*c == 'A' || *c == 'e' || *c == 'a' || *c == 'x') all = 1;
      else if (*c == 'w' || *c == 'c' || *c == 'h') continue;
      else if (*c == 'o' || *c == 'O' || *c == 'p' || *c == 'g' || *c == 'q') {
        char *arg = c[1] ? c + 1 : (i + 1 < argc ? argv[++i] : NULL);
        if (!arg) return usage("option requires an argument");
        int bad = *c == 'o' || *c == 'O' ? add_fields(arg) : *c == 'g' ? add_ids(arg, pgids, &npgids) : add_ids(arg, pids, &npids);
        if (bad) return 1;
        break;
      } else {
        char why[64];
        snprintf(why, sizeof why, "unsupported option -%c", *c);
        return usage(why);
      }
    }
  }
  if (!nfields) { add_fields("pid"); add_fields("command"); }
  int header = 0;
  for (int i = 0; i < nfields; i++) if (fields[i].header[0]) header = 1;
  if (header) for (int i = 0; i < nfields; i++) printf("%s%s", fields[i].header, i + 1 < nfields ? " " : "\n");

  int count = proc_listallpids(NULL, 0);
  if (count <= 0) return usage("process list unavailable");
  int *list = calloc((size_t)count + 64, sizeof(int));
  if (!list) return usage("out of memory");
  count = proc_listallpids(list, (int)(((size_t)count + 64) * sizeof(int)));
  int shown = 0;
  /* Kernel order is newest first; ps lists by pid. */
  for (int i = 0; i + 1 < count; i++) for (int j = i + 1; j < count; j++) if (list[j] < list[i]) { int t = list[i]; list[i] = list[j]; list[j] = t; }
  for (int i = 0; i < count; i++) {
    struct proc_bsdinfo b;
    if (proc_pidinfo(list[i], PROC_PIDTBSDINFO, 0, &b, sizeof b) != (int)sizeof b) continue;
    if (!wanted(list[i], &b)) continue;
    for (int f = 0; f < nfields; f++) print_field(fields[f].name, list[i], &b, f + 1 == nfields);
    shown++;
  }
  free(list);
  return (npids || npgids) && !shown ? 1 : 0;
}
