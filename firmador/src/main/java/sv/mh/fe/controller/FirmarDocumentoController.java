package sv.mh.fe.controller;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.ObjectWriter;
import java.io.IOException;
import java.security.NoSuchAlgorithmException;
import jakarta.validation.Valid;
import org.json.JSONObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;
import sv.mh.fe.business.CertificadoBusiness;
import sv.mh.fe.business.FirmarDocumentoBusiness;
import sv.mh.fe.constantes.Errores;
import sv.mh.fe.filter.FirmarDocumentoFilter;
import sv.mh.fe.models.CertificadoMH;
import sv.mh.fe.validations.FirmarDocumentoValidations;

@RestController
@RequestMapping({ "/firmardocumento" })
@CrossOrigin(origins = { "*" }, maxAge = 3600L)
public class FirmarDocumentoController extends Controller {
	static final Logger logger = LoggerFactory.getLogger(FirmarDocumentoController.class);
	@Autowired
	private CertificadoBusiness certificadoBusiness;
	@Autowired
	private FirmarDocumentoBusiness business;
	@Autowired
	private FirmarDocumentoValidations validation;

	public FirmarDocumentoController() {
	}

	@RequestMapping(value = { "/" }, method = { RequestMethod.POST })
	public ResponseEntity<?> firmar(@RequestBody @Valid FirmarDocumentoFilter filter) {
		CertificadoMH certificado = null;

		try {
			this.validation.v5validar(filter);
			if (!this.validation.isValido()) {
				return ResponseEntity.ok(this.mensaje.error("809", this.validation.getRequeridos()));
			}

			certificado = this.certificadoBusiness.recuperarCertifiado(filter);
			if (certificado == null) {
				return ResponseEntity.ok(this.mensaje.error(Errores.COD_803_ERROR_LLAVE_PRUBLICA));
			}

			ObjectWriter ow = (new ObjectMapper()).writer().withDefaultPrettyPrinter();

			try {
				String dteString = ow.writeValueAsString(filter.getDteJson());
				JSONObject dteObject = new JSONObject(dteString);
				if (dteObject != null) {
					logger.info("dteObject != null");
					String firma = this.business.firmarJSON(certificado, dteString);
					return ResponseEntity.ok(this.mensaje.ok(firma));
				}
			} catch (JsonProcessingException e) {
				logger.info("810", e.getMessage());
				return ResponseEntity.ok(this.mensaje.error(Errores.COD_810_CONVERTIR_JSON_A_STRING));
			} catch (Exception e) {
				logger.info("811", e.getMessage());
				return ResponseEntity.ok(this.mensaje.error(Errores.COD_811_CONVERTIR_STRING_A_JSON));
			}
		} catch (IOException e1) {
			logger.error(e1.getMessage());
			return ResponseEntity.ok(this.mensaje.error("812", e1.getMessage()));
		} catch (NoSuchAlgorithmException e1) {
			logger.error(e1.getMessage());
			return ResponseEntity.ok(this.mensaje.error("804", e1.getMessage()));
		}

		return ResponseEntity.ok(this.mensaje.error(Errores.COD_804_ERROR_NO_CATALOGADO));
	}

	@GetMapping({ "/status" })
	public String getStatus() {
		return "Application is running...!!";
	}
}
