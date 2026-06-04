package sv.mh.fe.business;

import java.nio.file.Path;
import java.security.PrivateKey;
import org.jose4j.jws.JsonWebSignature;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import sv.mh.fe.models.CertificadoMH;
import sv.mh.fe.security.KeyGenerator;
import sv.mh.fe.utils.FileUtils;

@Service
public class FirmarDocumentoBusiness {
	static final Logger logger = LoggerFactory.getLogger(FirmarDocumentoBusiness.class);
	@Autowired
	private FileUtils fileUtils;
	@Autowired
	private KeyGenerator keyGenerator;

	public FirmarDocumentoBusiness() {
	}

	public void firmarJSON(CertificadoMH certificado, Path ruta) throws Exception {
		String contenido = this.fileUtils.LeerArchivo(ruta);
		JsonWebSignature jws = new JsonWebSignature();
		jws.setPayload(contenido);
		jws.setAlgorithmHeaderValue("RS512");
		PrivateKey key = this.keyGenerator.ByteToPrivateKey(certificado.getPrivateKey().getEncodied());
		jws.setKey(key);
		this.fileUtils.crearArchivo(ruta.toString(), jws.getCompactSerialization());
	}

	public String firmarJSON(CertificadoMH certificado, String contenido) throws Exception {
		JsonWebSignature jws = new JsonWebSignature();
		jws.setPayload(contenido);
		jws.setAlgorithmHeaderValue("RS512");
		PrivateKey key = this.keyGenerator.ByteToPrivateKey(certificado.getPrivateKey().getEncodied());
		jws.setKey(key);
		return jws.getCompactSerialization();
	}
}
