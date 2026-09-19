import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileArchive,
  Loader2,
  RefreshCw,
  UploadCloud,
  XCircle,
} from "lucide-react"
import * as XLSX from "xlsx"
import { toast } from "sonner"

/**
 * Shared bulk menu import wizard (admin + restaurant).
 *
 * Steps: 1 type -> 2 template -> 3 ZIP -> 4 validate -> 5 preview -> 6 import -> 7 progress -> 8 result.
 * The browser uploads ONE ZIP; everything else (images, rows) is processed server-side.
 *
 * Props
 *  - api: { downloadTemplate(entity), validate(entity, file), start(jobId, body), status(jobId, params) }
 *  - restaurantSlot: node shown at the top (admin dropdown / restaurant read-only name)
 *  - canValidate: false until a restaurant is known (admin must select one first)
 *  - resetKey: change it (e.g. the selected restaurant id) to discard any in-progress package
 *  - approvalNote: short sentence describing what happens to imported rows
 */

const ENTITY_OPTIONS = [
  { value: "food", label: "Food items", hint: "Sheet: Foods" },
  { value: "addon", label: "Add-ons", hint: "Sheet: Addons (restaurant-level catalogue)" },
  { value: "both", label: "Food + Add-ons", hint: "Sheets: Foods and Addons" },
]

const POLL_MS = 2000
const PREVIEW_LIMIT = 200

const errorMessageOf = (error, fallback) =>
  error?.response?.data?.message || error?.message || fallback

const saveBlob = (blob, filename) => {
  const url = window.URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.URL.revokeObjectURL(url)
}

const StatCard = ({ label, value, tone = "slate" }) => {
  const tones = {
    slate: "bg-slate-50 text-slate-700 border-slate-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    red: "bg-red-50 text-red-700 border-red-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
  }
  return (
    <div className={`rounded-lg border px-4 py-3 ${tones[tone]}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs font-medium uppercase tracking-wide opacity-80">{label}</div>
    </div>
  )
}

const StepTitle = ({ n, children }) => (
  <div className="flex items-center gap-3 mb-3">
    <div className="w-7 h-7 rounded-full bg-emerald-500 text-white flex items-center justify-center text-sm font-bold">
      {n}
    </div>
    <h2 className="text-base font-bold text-slate-900">{children}</h2>
  </div>
)

const Section = ({ children }) => (
  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 mb-4">{children}</div>
)

const ProgressBar = ({ label, done, total }) => {
  if (!total) return null
  const pct = Math.min(100, Math.round((done / total) * 100))
  return (
    <div className="mb-3">
      <div className="flex justify-between text-sm text-slate-700 mb-1">
        <span>{label}</span>
        <span>
          {done} / {total}
        </span>
      </div>
      <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
        <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default function BulkMenuImportWizard({
  api,
  restaurantSlot = null,
  canValidate = true,
  resetKey = "",
  approvalNote = "",
}) {
  const [entity, setEntity] = useState("food")
  const [file, setFile] = useState(null)
  const [validating, setValidating] = useState(false)
  const [validation, setValidation] = useState(null)
  const [filter, setFilter] = useState("all")
  const [duplicateMode, setDuplicateMode] = useState("skip")
  const [starting, setStarting] = useState(false)
  const [job, setJob] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const fileInputRef = useRef(null)

  const reset = useCallback(() => {
    setFile(null)
    setValidation(null)
    setJob(null)
    setFilter("all")
    setDuplicateMode("skip")
    if (fileInputRef.current) fileInputRef.current.value = ""
  }, [])

  // A different restaurant/context invalidates any validated package.
  useEffect(() => {
    reset()
  }, [resetKey, reset])

  const importing = job && ["queued", "processing"].includes(job.status)
  const finished = job && ["completed", "failed"].includes(job.status)

  // Poll only while a job is actually running; stop as soon as it is terminal.
  useEffect(() => {
    if (!job?.jobId || !importing) return undefined
    let cancelled = false
    const tick = async () => {
      try {
        const res = await api.status(job.jobId)
        const data = res?.data?.data
        if (!cancelled && data) setJob(data)
      } catch (error) {
        // transient poll failures are ignored; the next tick retries
      }
    }
    const timer = setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [api, job?.jobId, importing])

  const pickFile = (picked) => {
    if (!picked) return
    if (!/\.zip$/i.test(picked.name)) {
      toast.error("Please choose a .zip file (menu.xlsx + images/)")
      return
    }
    setFile(picked)
    setValidation(null)
  }

  const handleDownloadTemplate = async (opts, filename) => {
    try {
      const res = await api.downloadTemplate(entity, { ...opts, ...(advanced ? { full: "1" } : {}) })
      saveBlob(res.data, filename)
    } catch (error) {
      toast.error("Could not download the file")
    }
  }

  const handleValidate = async () => {
    if (!file) return toast.error("Select the ZIP package first")
    setValidating(true)
    setValidation(null)
    setJob(null)
    try {
      const res = await api.validate(entity, file)
      const data = res?.data?.data
      setValidation(data)
      setFilter(data?.rows?.some((r) => r.status === "invalid") ? "invalid" : "all")
      const dup = (data?.summary?.food?.duplicates || 0) > 0
      if (dup) setDuplicateMode("skip")
    } catch (error) {
      toast.error(errorMessageOf(error, "Validation failed"))
    } finally {
      setValidating(false)
    }
  }

  const handleStart = async () => {
    if (!validation?.jobId) return
    setStarting(true)
    try {
      const res = await api.start(validation.jobId, { duplicateMode })
      const data = res?.data?.data
      setJob({
        jobId: data?.jobId || validation.jobId,
        jobCode: data?.jobCode || validation.jobCode,
        entity: validation.entity,
        status: data?.status || "queued",
        progress: {
          food: { total: validation.summary?.food?.valid || 0, done: 0 },
          addon: { total: validation.summary?.addon?.valid || 0, done: 0 },
        },
        counters: { imported: 0, skipped: 0, failed: 0 },
      })
    } catch (error) {
      toast.error(errorMessageOf(error, "Could not start the import"))
    } finally {
      setStarting(false)
    }
  }

  const downloadErrorReport = (rows) => {
    const problems = (rows || []).filter((r) => r.status === "invalid" || r.status === "failed")
    if (!problems.length) return toast.info("There are no errors to export")
    const sheet = XLSX.utils.json_to_sheet(
      problems.map((r) => ({
        rowNumber: r.rowNumber,
        entityType: r.entityType,
        itemName: r.name,
        errorCode: r.errorCode,
        errorMessage: r.errorMessage,
      })),
      { header: ["rowNumber", "entityType", "itemName", "errorCode", "errorMessage"] },
    )
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, sheet, "Errors")
    XLSX.writeFile(workbook, "bulk-import-errors.xlsx")
  }

  const summary = validation?.summary
  const rows = validation?.rows || []
  const totalValid = (summary?.food?.valid || 0) + (summary?.addon?.valid || 0)
  const totalInvalid = (summary?.food?.invalid || 0) + (summary?.addon?.invalid || 0)
  const duplicates = summary?.food?.duplicates || 0

  const visibleRows = useMemo(() => {
    const filtered = rows.filter((r) => {
      if (filter === "valid") return r.status === "pending"
      if (filter === "invalid") return r.status === "invalid"
      if (filter === "duplicates") return Boolean(r.duplicate)
      return true
    })
    return filtered
  }, [rows, filter])

  const resultRows = job?.rows || []
  const failedRows = resultRows.filter((r) => ["failed", "skipped", "invalid"].includes(r.status))

  return (
    <div className="max-w-5xl">
      {restaurantSlot ? <Section>{restaurantSlot}</Section> : null}

      {/* 1 + 2 + 3 */}
      {!importing && !finished ? (
        <>
          <Section>
            <StepTitle n={1}>Select import type</StepTitle>
            <div className="grid gap-3 sm:grid-cols-3">
              {ENTITY_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={`cursor-pointer rounded-lg border p-3 text-sm ${
                    entity === option.value ? "border-emerald-500 bg-emerald-50" : "border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  <input
                    type="radio"
                    name="bulk-entity"
                    className="mr-2"
                    checked={entity === option.value}
                    onChange={() => {
                      setEntity(option.value)
                      setValidation(null)
                    }}
                  />
                  <span className="font-semibold text-slate-900">{option.label}</span>
                  <div className="text-xs text-slate-500 mt-1 ml-5">{option.hint}</div>
                </label>
              ))}
            </div>
          </Section>

          <Section>
            <StepTitle n={2}>Download the template</StepTitle>
            <p className="text-sm text-slate-600 mb-3">
              Download a ready package (a ZIP that already has <b>menu.xlsx</b> and an empty <b>images/</b> folder). Fill
              the workbook, put the pictures in <code>images/</code>, then zip everything again. Each row names its image
              exactly (e.g. <code>F001.webp</code> must exist as <code>images/F001.webp</code>).
            </p>
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs font-mono text-slate-600 mb-3 leading-relaxed">
              fudron-menu-import.zip
              <br />
              &nbsp;&nbsp;├─ menu.xlsx <span className="text-slate-400">(sheets: Foods / Addons / README)</span>
              <br />
              &nbsp;&nbsp;└─ images/
              <br />
              &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;├─ F001.webp
              <br />
              &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└─ A001.webp
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => handleDownloadTemplate({ format: "zip" }, "fudron-menu-import.zip")}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500 text-white text-sm font-semibold hover:bg-emerald-600"
              >
                <Download className="w-4 h-4" /> Download blank package (.zip)
              </button>
              <button
                type="button"
                disabled={!canValidate}
                title={canValidate ? "" : "Select a restaurant first"}
                onClick={() => handleDownloadTemplate({ format: "zip", sample: "1" }, "fudron-menu-import-sample.zip")}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-emerald-500 text-emerald-700 text-sm font-semibold hover:bg-emerald-50 disabled:opacity-50"
              >
                <Download className="w-4 h-4" /> Download sample package (try it)
              </button>
              <button
                type="button"
                onClick={() => handleDownloadTemplate({}, `fudron-menu-${entity}-template.xlsx`)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-200 text-slate-700 text-sm font-semibold hover:bg-slate-50"
              >
                <Download className="w-4 h-4" /> Excel only
              </button>
            </div>
            <label className="mt-3 inline-flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} />
              Include advanced columns (variants/sizes, extra images, discounts, tags, availability times…)
            </label>
            <p className="text-xs text-slate-500 mt-2">
              The sample package contains 2 example rows with pictures (named &quot;Sample … (delete me)&quot;) using a real
              category of this restaurant, so you can upload it straight away to see the whole flow.
            </p>
          </Section>

          <Section>
            <StepTitle n={3}>Upload the ZIP package</StepTitle>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => pickFile(e.target.files?.[0] || null)}
            />
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragging(false)
                pickFile(e.dataTransfer.files?.[0] || null)
              }}
              className={`cursor-pointer rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${
                dragging ? "border-emerald-500 bg-emerald-50" : file ? "border-emerald-400 bg-emerald-50/50" : "border-slate-300 hover:bg-slate-50"
              }`}
            >
              {file ? (
                <div className="flex flex-col items-center gap-1 text-slate-800">
                  <FileArchive className="w-8 h-8 text-emerald-600" />
                  <div className="font-semibold">{file.name}</div>
                  <div className="text-xs text-slate-500">{(file.size / 1024 / 1024).toFixed(2)} MB · click to choose a different file</div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-1 text-slate-600">
                  <UploadCloud className="w-8 h-8 text-slate-400" />
                  <div className="font-semibold text-slate-800">Drag &amp; drop your ZIP here, or click to browse</div>
                  <div className="text-xs text-slate-500">Only .zip · menu.xlsx + images/ · max 150 MB</div>
                </div>
              )}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={!file || validating || !canValidate}
                onClick={handleValidate}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
              >
                {validating ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
                {validating ? "Uploading & validating…" : "Upload & validate"}
              </button>
              {!canValidate ? (
                <span className="text-sm text-amber-600">Step 0: select a restaurant at the top first.</span>
              ) : !file ? (
                <span className="text-sm text-slate-500">Choose a ZIP file to enable this button.</span>
              ) : null}
            </div>
            <p className="text-xs text-slate-500 mt-2">Validation only checks the file. Nothing is saved until you press Import in the next step.</p>
          </Section>

          {!validation ? (
            <Section>
              <StepTitle n={4}>Save / Import</StepTitle>
              <p className="text-sm text-slate-600 mb-3">
                After you press <b>Upload &amp; validate</b>, a preview of every row appears here (green = OK, red = problem with
                the reason). The <b>Import</b> button below then saves the valid rows.
              </p>
              <button type="button" disabled className="px-5 py-2.5 rounded-lg bg-slate-300 text-white text-sm font-semibold cursor-not-allowed">
                Import (available after validation)
              </button>
            </Section>
          ) : null}
        </>
      ) : null}

      {/* 4 + 5 + 6: validation result & preview */}
      {validation && !importing && !finished ? (
        <Section>
          <StepTitle n={4}>Validation result</StepTitle>
          <div className="grid gap-3 grid-cols-2 md:grid-cols-4 mb-4">
            {entity !== "addon" ? (
              <>
                <StatCard label="Food rows" value={summary.food.total} />
                <StatCard label="Food valid" value={summary.food.valid} tone="green" />
                <StatCard label="Food invalid" value={summary.food.invalid} tone={summary.food.invalid ? "red" : "slate"} />
                <StatCard label="Possible duplicates" value={duplicates} tone={duplicates ? "amber" : "slate"} />
              </>
            ) : null}
            {entity !== "food" ? (
              <>
                <StatCard label="Add-on rows" value={summary.addon.total} />
                <StatCard label="Add-ons valid" value={summary.addon.valid} tone="green" />
                <StatCard label="Add-ons invalid" value={summary.addon.invalid} tone={summary.addon.invalid ? "red" : "slate"} />
              </>
            ) : null}
            <StatCard label="Images found" value={summary.images.found} tone="green" />
            <StatCard label="Images missing" value={summary.images.missing} tone={summary.images.missing ? "red" : "slate"} />
            <StatCard label="Images invalid" value={summary.images.invalid} tone={summary.images.invalid ? "red" : "slate"} />
          </div>

          {summary.ignoredEntries?.length ? (
            <p className="text-xs text-slate-500 mb-3">
              Ignored {summary.ignoredEntries.length} unexpected ZIP entr{summary.ignoredEntries.length === 1 ? "y" : "ies"}{" "}
              (only menu.xlsx and images/ are used).
            </p>
          ) : null}

          <StepTitle n={5}>Preview</StepTitle>
          <div className="flex flex-wrap gap-2 mb-3">
            {[
              ["all", `All (${rows.length})`],
              ["valid", `Valid (${totalValid})`],
              ["invalid", `Invalid (${totalInvalid})`],
              ["duplicates", `Duplicates (${duplicates})`],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={`px-3 py-1 rounded-full text-xs font-semibold border ${
                  filter === value ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200"
                }`}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => downloadErrorReport(rows)}
              disabled={!totalInvalid}
              className="ml-auto inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-semibold border border-slate-200 text-slate-700 disabled:opacity-40"
            >
              <Download className="w-3 h-3" /> Download error report
            </button>
          </div>

          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <div className="max-h-96 overflow-auto divide-y divide-slate-100">
              {visibleRows.slice(0, PREVIEW_LIMIT).map((row) => (
                <div key={`${row.entityType}-${row.rowNumber}`} className="flex gap-3 px-3 py-2 text-sm">
                  <span className="w-16 shrink-0 text-slate-400">Row {row.rowNumber}</span>
                  <span className="w-14 shrink-0 text-xs uppercase text-slate-400">{row.entityType}</span>
                  <span className="flex-1 min-w-0">
                    <span className="font-medium text-slate-900">{row.name || row.code || "(no name)"}</span>
                    {row.status === "invalid" ? (
                      <span className="flex items-start gap-1 text-red-600 text-xs mt-0.5">
                        <XCircle className="w-3.5 h-3.5 mt-px shrink-0" /> {row.errorMessage}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-emerald-600 text-xs mt-0.5">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Valid
                      </span>
                    )}
                    {row.warnings?.map((warning) => (
                      <span key={warning} className="flex items-start gap-1 text-amber-600 text-xs mt-0.5">
                        <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" /> {warning}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
              {visibleRows.length === 0 ? <div className="px-3 py-6 text-sm text-slate-500 text-center">No rows in this view.</div> : null}
            </div>
            {visibleRows.length > PREVIEW_LIMIT ? (
              <div className="px-3 py-2 text-xs text-slate-500 bg-slate-50">
                Showing first {PREVIEW_LIMIT} of {visibleRows.length}. Use the filters or download the error report.
              </div>
            ) : null}
          </div>

          {duplicates > 0 ? (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
              <div className="font-semibold text-amber-800 mb-2">Duplicate foods ({duplicates})</div>
              <p className="text-amber-800 mb-2">
                These rows match a food with the same name and category (already saved, or repeated in this file).
              </p>
              <label className="mr-6 inline-flex items-center gap-2">
                <input type="radio" checked={duplicateMode === "skip"} onChange={() => setDuplicateMode("skip")} /> Skip duplicates
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="radio" checked={duplicateMode === "createAnyway"} onChange={() => setDuplicateMode("createAnyway")} /> Create anyway
              </label>
            </div>
          ) : null}

          <div className="mt-5 border-t border-slate-100 pt-4">
            <StepTitle n={6}>Import</StepTitle>
            {totalInvalid > 0 ? (
              <p className="text-sm text-slate-600 mb-3">
                {totalInvalid} invalid row(s) will <b>not</b> be imported. Fix them and upload again, or import the valid rows now.
              </p>
            ) : null}
            {approvalNote ? <p className="text-sm text-slate-500 mb-3">{approvalNote}</p> : null}
            <div className="flex gap-3">
              <button
                type="button"
                disabled={totalValid === 0 || starting}
                onClick={handleStart}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500 text-white text-sm font-semibold hover:bg-emerald-600 disabled:opacity-50"
              >
                {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Import {totalValid} valid row{totalValid === 1 ? "" : "s"}
              </button>
              <button type="button" onClick={reset} className="px-4 py-2 rounded-lg border border-slate-200 text-sm font-semibold text-slate-700">
                Cancel
              </button>
            </div>
          </div>
        </Section>
      ) : null}

      {/* 7: progress */}
      {importing ? (
        <Section>
          <StepTitle n={7}>Importing… {job.jobCode ? <span className="text-slate-400 font-normal">({job.jobCode})</span> : null}</StepTitle>
          <div className="flex items-center gap-2 text-sm text-slate-600 mb-4">
            <Loader2 className="w-4 h-4 animate-spin" />
            {job.status === "queued" ? "Waiting to start…" : "Processing rows and images on the server. You can leave this page open."}
          </div>
          <ProgressBar label="Food items" done={job.progress?.food?.done || 0} total={job.progress?.food?.total || 0} />
          <ProgressBar label="Add-ons" done={job.progress?.addon?.done || 0} total={job.progress?.addon?.total || 0} />
          <div className="grid grid-cols-3 gap-3 mt-3">
            <StatCard label="Imported" value={job.counters?.imported || 0} tone="green" />
            <StatCard label="Skipped" value={job.counters?.skipped || 0} tone="amber" />
            <StatCard label="Failed" value={job.counters?.failed || 0} tone="red" />
          </div>
        </Section>
      ) : null}

      {/* 8: result */}
      {finished ? (
        <Section>
          <StepTitle n={8}>{job.status === "completed" ? "Import finished" : "Import failed"}</StepTitle>
          {job.status === "failed" ? (
            <p className="text-sm text-red-600 mb-3">{job.error || "The import stopped unexpectedly. Rows already imported were kept."}</p>
          ) : null}
          <div className="grid grid-cols-3 gap-3 mb-4">
            <StatCard label="Imported" value={job.counters?.imported || 0} tone="green" />
            <StatCard label="Skipped" value={job.counters?.skipped || 0} tone="amber" />
            <StatCard label="Failed / invalid" value={(job.counters?.failed || 0) + (job.validation?.food?.invalid || 0) + (job.validation?.addon?.invalid || 0)} tone="red" />
          </div>
          {approvalNote ? <p className="text-sm text-slate-500 mb-3">{approvalNote}</p> : null}

          {failedRows.length ? (
            <div className="border border-slate-200 rounded-lg max-h-72 overflow-auto divide-y divide-slate-100 mb-4">
              {failedRows.slice(0, PREVIEW_LIMIT).map((row) => (
                <div key={`${row.entityType}-${row.rowNumber}`} className="flex gap-3 px-3 py-2 text-sm">
                  <span className="w-16 shrink-0 text-slate-400">Row {row.rowNumber}</span>
                  <span className="flex-1">
                    <span className="font-medium">{row.name || row.code}</span>
                    <span className={`block text-xs ${row.status === "skipped" ? "text-amber-600" : "text-red-600"}`}>
                      {row.status}: {row.errorMessage}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => downloadErrorReport(resultRows)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-200 text-sm font-semibold text-slate-700"
            >
              <Download className="w-4 h-4" /> Download error report
            </button>
            <button type="button" onClick={reset} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-semibold">
              <RefreshCw className="w-4 h-4" /> Import another package
            </button>
          </div>
        </Section>
      ) : null}
    </div>
  )
}
