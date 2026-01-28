;;; blok-lsp.el --- Blok Workflow LSP integration for Emacs
;;
;; Add this to your Emacs config (init.el or .emacs)
;; Requires: lsp-mode (https://emacs-lsp.github.io/lsp-mode/)
;; Install: npm install -g @blok/lsp-server

(with-eval-after-load 'lsp-mode
  ;; Register the Blok LSP server
  (lsp-register-client
   (make-lsp-client
    :new-connection (lsp-stdio-connection '("blok-lsp" "--stdio"))
    :activation-fn (lsp-activate-on "json")
    :server-id 'blok-lsp
    :priority -1
    :initialization-options
    '((blok
       (workflowGlob . "**/workflows/**/*.json")
       (maxDiagnostics . 100)))))

  ;; Add to the auto-start list
  (add-to-list 'lsp-language-id-configuration '(json-mode . "json")))
