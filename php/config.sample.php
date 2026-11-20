<?php
/*
 * Configuration facultative d'Espace Documents (version PHP).
 * Copiez ce fichier en « config.php » pour l'utiliser. Sans lui, les valeurs par défaut s'appliquent
 * et tout se règle depuis l'interface (Administration → Paramètres).
 */
return [
    // Dossier des données (base SQLite, fichiers, versions). Idéalement HORS du dossier web :
    // 'data_dir' => '/home/monsite/espace-documents-data',
    'data_dir' => __DIR__ . '/data',

    // Adresse publique, à renseigner seulement si la détection automatique se trompe (proxy, CDN…)
    'app_url' => '',

    // Valeurs initiales (modifiables ensuite dans Administration → Paramètres)
    'app_name' => 'Espace Documents',
    'default_quota' => '10G',
    'trash_days' => 30,
    'max_versions' => 20,
    'allow_signup' => false,

    // OnlyOffice Docs (facultatif, modifiable aussi dans l'interface)
    'onlyoffice_url' => '',            // ex. https://office.mondomaine.fr
    'onlyoffice_jwt_secret' => '',
    'onlyoffice_internal_url' => '',   // adresse du drive vue depuis OnlyOffice, si différente

    // Compte administrateur créé automatiquement s'il n'existe pas (sinon : le premier inscrit devient admin)
    'admin_email' => '',
    'admin_password' => '',
];
